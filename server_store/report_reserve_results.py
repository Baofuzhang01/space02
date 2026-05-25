from __future__ import annotations

import argparse
import ast
import datetime as dt
import json
import os
import pathlib
import re
import socket
import sys
import urllib.error
import urllib.request
from typing import Any

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

DEFAULT_PROJECT_ROOT = "/opt/Main_ChaoXingReserveSeat"
DEFAULT_RESULT_CENTER_URL = ""
PROCESSED_RESULTS_FILE = "processed_results.json"
REPORT_STATE_FILE = "result_report_state.json"
MAX_LOG_CHARS = 700_000
BEIJING_TZ = dt.timezone(dt.timedelta(hours=8))


def beijing_now() -> dt.datetime:
    return dt.datetime.now(BEIJING_TZ)


def normalize_text(value: Any, limit: int = 500) -> str:
    text = str(value or "").strip()
    return text[:limit]


def env_flag_enabled(name: str) -> bool:
    return normalize_text(os.getenv(name), 20).lower() in {"1", "true", "yes", "on"}


def mask_account(account: str) -> str:
    text = normalize_text(account, 120)
    if len(text) <= 4:
        return text
    if len(text) <= 7:
        return text[:3] + "*" * (len(text) - 3)
    return text[:3] + "****" + text[-4:]


def first_seat(value: Any) -> str:
    if isinstance(value, list):
        for item in value:
            seat = normalize_text(item, 80)
            if seat:
                return seat
        return ""
    text = normalize_text(value, 120)
    if "," in text:
        return normalize_text(text.split(",", 1)[0], 80)
    return text


def unique_join(values: list[str], limit: int = 80) -> str:
    seen: set[str] = set()
    items: list[str] = []
    for value in values:
        text = normalize_text(value, 80)
        if text and text not in seen:
            seen.add(text)
            items.append(text)
    return normalize_text("、".join(items), limit)


def seat_values(value: Any) -> list[str]:
    if isinstance(value, list):
        seats: list[str] = []
        for item in value:
            if isinstance(item, dict):
                seats.extend(seat_values(item.get("seatid") or item.get("seat") or item.get("s")))
            else:
                seat = normalize_text(item, 80)
                if seat:
                    seats.append(seat)
        return seats
    text = normalize_text(value, 500).replace("，", ",")
    if not text:
        return []
    seats = []
    for token in text.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            token = token.split("-", 1)[1].strip()
        if token:
            seats.append(normalize_text(token, 80))
    return seats


def parse_backup_seat(value: Any) -> str:
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, dict):
                continue
            seat = normalize_text(item.get("seatid") or item.get("s"), 80)
            if seat:
                return seat
        return ""
    text = normalize_text(value, 500).replace("，", ",")
    for token in text.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            return normalize_text(token.split("-", 1)[1], 80)
        return normalize_text(token, 80)
    return ""


def normalize_time_range(start: Any, end: Any) -> str:
    start_text = normalize_text(start, 20)
    end_text = normalize_text(end, 20)
    if start_text and end_text:
        return f"{start_text}-{end_text}"
    return ""


def time_range_from_text(value: Any) -> str:
    text = normalize_text(value, 80).replace("~", "-").replace("—", "-").replace("–", "-")
    if "-" not in text:
        return ""
    start, end = text.split("-", 1)
    return normalize_time_range(start.strip(), end.strip())


def extract_user_slots(user: dict) -> list[dict]:
    slots: list[dict] = []
    raw_slots = user.get("slots")
    if isinstance(raw_slots, list):
        for slot in raw_slots:
            if not isinstance(slot, dict):
                continue
            time_range = time_range_from_text(slot.get("times")) or normalize_time_range(slot.get("startTime"), slot.get("endTime"))
            slots.append(
                {
                    "time": time_range,
                    "roomId": normalize_text(slot.get("roomid") or slot.get("roomId") or slot.get("seatPageId"), 80),
                    "primary": seat_values(slot.get("seatid")),
                    "backup": seat_values(slot.get("backupSeats") or slot.get("backupSlots")),
                }
            )
    if not slots:
        time_range = time_range_from_text(user.get("times")) or normalize_time_range(user.get("startTime"), user.get("endTime"))
        slots.append(
            {
                "time": time_range,
                "roomId": normalize_text(user.get("roomid") or user.get("roomId") or user.get("seatPageId"), 80),
                "primary": seat_values(user.get("seatid")),
                "backup": seat_values(user.get("backupSeats") or user.get("backupSlots")),
            }
        )
    return slots


def match_user_slot(slots: list[dict], attempt: dict) -> dict:
    attempt_time = normalize_text(attempt.get("time"), 80)
    attempt_room = normalize_text(attempt.get("roomId"), 80)
    for slot in slots:
        if attempt_time and slot.get("time") == attempt_time:
            return slot
    for slot in slots:
        if attempt_room and slot.get("roomId") == attempt_room:
            return slot
    return {}


def load_json(path: pathlib.Path, default: Any):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: pathlib.Path, payload: Any) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def read_log(path: pathlib.Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""
    if len(text) > MAX_LOG_CHARS:
        return text[-MAX_LOG_CHARS:]
    return text


def parse_run_dir_datetime(name: str) -> dt.datetime | None:
    match = re.match(r"^(\d{8})_(\d{6})(?:_(\d{1,6}))?$", str(name or ""))
    if not match:
        return None
    date_part, time_part, micro_part = match.groups()
    micro = (micro_part or "0")[:6].ljust(6, "0")
    try:
        return dt.datetime.strptime(
            f"{date_part}{time_part}{micro}",
            "%Y%m%d%H%M%S%f",
        ).replace(tzinfo=BEIJING_TZ)
    except ValueError:
        return None


def iter_today_run_dirs(runs_dir: pathlib.Path, today: dt.date | None = None) -> list[pathlib.Path]:
    if not runs_dir.exists():
        return []
    target_day = today or beijing_now().date()
    items: list[pathlib.Path] = []
    for entry in runs_dir.iterdir():
        if not entry.is_dir():
            continue
        summary_path = entry / "summary.json"
        if not summary_path.exists():
            continue
        run_dt = parse_run_dir_datetime(entry.name)
        if run_dt is not None:
            if run_dt.date() == target_day:
                items.append(entry)
            continue
        try:
            mtime = dt.datetime.fromtimestamp(summary_path.stat().st_mtime, BEIJING_TZ)
        except Exception:
            continue
        if mtime.date() == target_day:
            items.append(entry)
    items.sort(key=lambda path: path.name)
    return items


def user_by_index(payload: dict, index: int) -> dict:
    users = payload.get("users")
    if isinstance(users, list) and 1 <= index <= len(users):
        user = users[index - 1]
        return user if isinstance(user, dict) else {}
    return payload if isinstance(payload, dict) else {}


def parse_literal_dict(text: str) -> dict | None:
    raw_text = str(text or "").strip()
    if not raw_text.startswith("{"):
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start >= 0 and end > start:
            raw_text = raw_text[start : end + 1]
    try:
        obj = ast.literal_eval(raw_text)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def extract_seat_reserve(result: Any) -> dict:
    if not isinstance(result, dict):
        return {}
    data = result.get("data")
    if not isinstance(data, dict):
        return {}
    seat_reserve = data.get("seatReserve")
    return seat_reserve if isinstance(seat_reserve, dict) else {}


def success_seat_from_attempt(attempt: dict) -> str:
    result = attempt.get("result") if isinstance(attempt.get("result"), dict) else {}
    if result.get("success") is not True:
        return ""
    seat_reserve = extract_seat_reserve(result)
    return normalize_text(seat_reserve.get("seatNum") or attempt.get("seatNum"), 80)


def success_room_from_attempt(attempt: dict) -> str:
    result = attempt.get("result") if isinstance(attempt.get("result"), dict) else {}
    if result.get("success") is not True:
        return ""
    seat_reserve = extract_seat_reserve(result)
    return normalize_text(seat_reserve.get("roomId") or attempt.get("roomId"), 80)


def success_day_from_attempt(attempt: dict) -> str:
    result = attempt.get("result") if isinstance(attempt.get("result"), dict) else {}
    if result.get("success") is not True:
        return ""
    seat_reserve = extract_seat_reserve(result)
    return normalize_text(seat_reserve.get("today") or attempt.get("day"), 32)


def success_location_from_attempt(attempt: dict) -> dict:
    result = attempt.get("result") if isinstance(attempt.get("result"), dict) else {}
    seat_reserve = extract_seat_reserve(result)
    return {
        "firstLevelName": normalize_text(seat_reserve.get("firstLevelName"), 120),
        "secondLevelName": normalize_text(seat_reserve.get("secondLevelName"), 120),
        "thirdLevelName": normalize_text(seat_reserve.get("thirdLevelName"), 120),
    }


def extract_submit_attempts(log_text: str) -> list[dict]:
    attempts: list[dict] = []
    current: dict | None = None
    for line in log_text.splitlines():
        if "submit parameter resolved:" in line and "submit_param=" in line:
            raw_times_match = re.search(r"raw_times=(\[[^\]]*\])", line)
            raw_times = []
            if raw_times_match:
                parsed_times = parse_literal_dict("{'raw_times': " + raw_times_match.group(1) + "}")
                raw_times = parsed_times.get("raw_times") if isinstance(parsed_times, dict) else []
            raw = line.split("submit_param=", 1)[1].strip()
            submit_param = parse_literal_dict(raw)
            if submit_param:
                start_time = normalize_text(submit_param.get("startTime"), 20)
                end_time = normalize_text(submit_param.get("endTime"), 20)
                if isinstance(raw_times, list) and len(raw_times) >= 2:
                    start_time = normalize_text(raw_times[0], 20) or start_time
                    end_time = normalize_text(raw_times[1], 20) or end_time
                current = {
                    "roomId": normalize_text(submit_param.get("roomId"), 80),
                    "seatNum": normalize_text(submit_param.get("seatNum"), 80),
                    "day": normalize_text(submit_param.get("day"), 32),
                    "startTime": start_time,
                    "endTime": end_time,
                    "time": normalize_time_range(start_time, end_time),
                    "result": None,
                }
                attempts.append(current)
            continue

        stripped = line.strip()
        if current is not None and "'success'" in stripped:
            result = parse_literal_dict(stripped)
            if result is not None:
                current["result"] = result
                if result.get("success") is True:
                    seat_reserve = extract_seat_reserve(result)
                    if seat_reserve:
                        current["actualRoomId"] = normalize_text(seat_reserve.get("roomId"), 80)
                        current["actualSeatNum"] = normalize_text(seat_reserve.get("seatNum"), 80)
                        current["actualDay"] = normalize_text(seat_reserve.get("today"), 32)
                        current["firstLevelName"] = normalize_text(seat_reserve.get("firstLevelName"), 120)
                        current["secondLevelName"] = normalize_text(seat_reserve.get("secondLevelName"), 120)
                        current["thirdLevelName"] = normalize_text(seat_reserve.get("thirdLevelName"), 120)
    return attempts


def extract_log_timestamp(line: str) -> str:
    match = re.match(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})", str(line or ""))
    return match.group(1) if match else ""


def strip_log_prefix(line: str) -> str:
    text = str(line or "").strip()
    return re.sub(
        r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[Asia/Shanghai\] - [A-Z]+ -\s*",
        "",
        text,
    )


def sanitize_admin_log_line(line: str) -> str:
    text = strip_log_prefix(line)
    text = re.sub(r"(captcha':\s*')[^']+", r"\1<captcha>", text)
    text = re.sub(r"(captcha=)[^,\s}]+", r"\1<captcha>", text)
    text = re.sub(r"(validate_[A-Za-z0-9_]+)", "<captcha>", text)
    text = re.sub(r"(submit enc:\s*)[0-9a-fA-F]+", r"\1<enc>", text)
    text = re.sub(r"(Got token from .*?:\s*)[^,\s]+", r"\1<token>", text)
    text = re.sub(r"(got token from .*?:\s*)[^,\s]+", r"\1<token>", text, flags=re.IGNORECASE)
    return normalize_text(text, 1200)


def extract_admin_timeline(log_text: str) -> list[dict]:
    timeline: list[dict] = []
    submit_count = 0
    first_submit_seen = False
    patterns = [
        ("captcha", "验证码", "Captcha submit order after normalization"),
        ("captcha", "验证码", "Pre-resolved slider captcha"),
        ("captcha", "验证码", "Pre-resolved textclick captcha"),
        ("captcha", "验证码", "Textclick captcha token"),
        ("captcha", "验证码", "Slider captcha token"),
        ("captcha", "验证码", "On-demand"),
        ("token", "Token", "Got token from"),
        ("token", "Token", "got token from"),
        ("token", "Token", "Get token from"),
        ("token", "Token", "Pre-fetched shared token"),
        ("seat_query", "查座响应", "seat getusedtimes response"),
        ("seat_query", "查座冲突判断", "seat getusedtimes conflict check"),
        ("seat_query", "查座决策", "is not conflicted, keep primary"),
        ("seat_query", "查座决策", "conflicted, switch to backup"),
        ("seat_query", "查座决策", "skipped because getusedtimes is conflicted"),
        ("submit", "提交参数", "submit parameter resolved"),
        ("submit", "提交签名", "submit enc:"),
        ("submit", "提交结果", "'success':"),
        ("submit", "提交跳转", "代码:302"),
        ("submit", "提交跳转", "代码:303"),
        ("token", "页面跳转", "HTTP 302"),
        ("token", "页面跳转", "HTTP 303"),
        ("token", "未开放", "当前区域未到开放预约时间"),
    ]
    for line in log_text.splitlines():
        if "submit parameter resolved" in line:
            submit_count += 1
            first_submit_seen = True
        if submit_count > 3:
            break
        for event_type, label, needle in patterns:
            if needle in line:
                if not first_submit_seen and event_type not in {"captcha", "token", "seat_query"}:
                    continue
                timeline.append(
                    {
                        "time": extract_log_timestamp(line),
                        "shot": submit_count if first_submit_seen else 0,
                        "type": event_type,
                        "label": label,
                        "message": sanitize_admin_log_line(line),
                    }
                )
                break
    return timeline[-80:]


def extract_first_primary_conflict(log_text: str) -> dict:
    """只提取首抢提交前的查座冲突；没有冲突时返回空。"""
    last_response: dict = {}
    for line in log_text.splitlines():
        if "submit parameter resolved" in line:
            break

        if "seat getusedtimes response:" in line:
            response_text = line.split("seat getusedtimes response:", 1)[1].strip()
            parsed_response = parse_literal_dict(response_text) or {}
            last_response = {
                "time": extract_log_timestamp(line),
                "data": parsed_response.get("data") if isinstance(parsed_response, dict) else None,
                "message": sanitize_admin_log_line(line),
            }
            continue

        if "seat getusedtimes conflict check:" not in line or "conflict=True" not in line:
            continue

        text = strip_log_prefix(line)
        seat_match = re.search(r"seat=([^,\s]+)", text)
        requested_match = re.search(r"requested=([^,]+)", text)
        used_match = re.search(r"used=(\[[^\]]*\])", text)
        conflict_intervals_match = re.search(r"conflict_intervals=(\[[^\]]*\])", text)
        checked_at = last_response.get("time") or extract_log_timestamp(line)
        seat = normalize_text(seat_match.group(1) if seat_match else "", 80)
        requested = normalize_text(requested_match.group(1) if requested_match else "", 120)
        used_text = normalize_text(used_match.group(1) if used_match else "", 300)
        conflict_intervals = normalize_text(
            conflict_intervals_match.group(1) if conflict_intervals_match else "",
            300,
        )
        return {
            "conflict": True,
            "checkedAt": checked_at,
            "seat": seat,
            "requested": requested,
            "used": used_text,
            "conflictIntervals": conflict_intervals,
            "responseData": last_response.get("data"),
            "message": f"首抢座位{seat or '未识别'}在 {checked_at or '未知时间'} 查座时已被其它用户占用",
        }

    return {}


def format_admin_timeline(timeline: list[dict]) -> str:
    if not timeline:
        return ""
    lines = []
    for item in timeline[-30:]:
        time_text = item.get("time") or "未知时间"
        label = item.get("label") or item.get("type") or "事件"
        shot = int(item.get("shot") or 0)
        shot_text = f"第{shot}抢 " if shot > 0 else "前三抢准备 "
        message = item.get("message") or ""
        lines.append(f"{time_text} [{shot_text}{label}] {message}")
    return "\n".join(lines)


def last_failure_message(attempts: list[dict], log_text: str) -> str:
    for attempt in reversed(attempts):
        result = attempt.get("result")
        if isinstance(result, dict):
            msg = normalize_text(result.get("msg"), 300)
            if msg:
                return msg
    for pattern in [
        r"Login rejected for .*?:\s*(.+)",
        r"Login bootstrap rejected for .*?:\s*(.+)",
        r"Abort program because submit returned fatal msg:\s*(.+)",
        r"failure reason:\s*(.+?);",
    ]:
        match = re.search(pattern, log_text, re.IGNORECASE)
        if match:
            return normalize_text(match.group(1), 300)
    return ""


def classify_failure(log_text: str, message: str, returncode: int) -> tuple[str, str]:
    combined = f"{message}\n{log_text[-12000:]}".lower()
    raw_combined = f"{message}\n{log_text[-12000:]}"
    if "代码:302" in raw_combined or "代码：302" in raw_combined:
        return "submit_security_timeout_302", message or "页面安全验证超时（代码302），未能确认预约结果"
    if "代码:303" in raw_combined or "代码：303" in raw_combined:
        return "submit_redirect_303", message or "提交时发生页面跳转（代码303），未能确认预约结果"
    if re.search(r"\bHTTP\s*30[23]\b", raw_combined, re.IGNORECASE):
        return "http_redirect", message or "请求发生 302/303 跳转，未能确认预约结果"
    if "当前区域未到开放预约时间" in raw_combined:
        return "not_open_yet", message or "当前区域未到开放预约时间"
    if "账号密码错误" in raw_combined or "密码错误" in raw_combined or "用户名或密码错误" in raw_combined:
        return "account_error", "账户或密码错误，未能完成预约"
    if "login rejected" in combined or "login bootstrap rejected" in combined:
        return "account_error", message or "账户登录失败，未能完成预约"
    if "验证码" in raw_combined or "captcha" in combined or "empty captcha" in combined:
        return "captcha_failed", message or "验证码处理失败，未能完成预约"
    if "已被占用" in raw_combined or "已有预约" in raw_combined or "conflict=true" in combined:
        return "seat_occupied", message or "座位已被占或当前时间段已有预约"
    if "非法预约" in raw_combined or "违约次数上限" in raw_combined:
        return "invalid_reservation", message or "非法预约或违约次数达到上限"
    if "token fetch failed" in combined or "request failed" in combined or "timeout" in combined or "超时" in raw_combined:
        return "timeout", message or "请求超时或网络异常，未能确认预约结果"
    if returncode != 0 or "traceback" in combined or "exception" in combined or "systemexit" in combined:
        return "exception", message or "程序异常中断，未能确认预约结果"
    return "unknown_failed", message or "未能完成预约，具体原因请联系管理员查看"


def build_result(run_dir: pathlib.Path, summary: dict, payload: dict, item: dict, server_id: str) -> dict:
    index = int(item.get("index") or 0)
    user = user_by_index(payload, index)
    log_path = pathlib.Path(str(item.get("log_path") or ""))
    if not log_path.is_absolute():
        log_path = run_dir / log_path
    elif not log_path.exists():
        fallback_log_path = run_dir / log_path.name
        if fallback_log_path.exists():
            log_path = fallback_log_path
    log_text = read_log(log_path)
    attempts = extract_submit_attempts(log_text)
    admin_timeline = extract_admin_timeline(log_text)
    first_primary_conflict = extract_first_primary_conflict(log_text)
    success_attempt = next(
        (
            attempt
            for attempt in attempts
            if isinstance(attempt.get("result"), dict) and attempt["result"].get("success") is True
        ),
        None,
    )

    user_slots = extract_user_slots(user)
    configured_primary_seats = [seat for slot in user_slots for seat in slot.get("primary", [])]
    configured_backup_seats = [seat for slot in user_slots for seat in slot.get("backup", [])]
    primary = unique_join(configured_primary_seats) or first_seat(user.get("seatid"))
    backup = unique_join(configured_backup_seats) or parse_backup_seat(user.get("backupSeats") or user.get("backupSlots"))
    successful_attempts = [
        attempt
        for attempt in attempts
        if isinstance(attempt.get("result"), dict) and attempt["result"].get("success") is True
    ]
    final_seat = unique_join([success_seat_from_attempt(attempt) for attempt in successful_attempts])
    if not final_seat:
        final_seat = success_seat_from_attempt(success_attempt or {})
    reserve_date = success_day_from_attempt(success_attempt or {})
    if not reserve_date:
        reserve_date = normalize_text((success_attempt or {}).get("day"), 32)
    if not reserve_date and attempts:
        reserve_date = normalize_text(attempts[0].get("day"), 32)
    if not reserve_date:
        reserve_date = beijing_now().date().isoformat()

    school_id = normalize_text(payload.get("school_id") or payload.get("schoolId") or user.get("school_id") or user.get("schoolId"), 80)
    user_id = normalize_text(user.get("id") or user.get("user_id") or user.get("userId"), 120)
    account = normalize_text(user.get("phone") or user.get("username") or item.get("username"), 120)
    account_masked = mask_account(account)
    returncode = int(item.get("returncode") if item.get("returncode") is not None else 0)

    nickname = normalize_text(user.get("nickname") or user.get("nickName") or user.get("remark") or user.get("name"), 120)
    attempt_results: list[dict] = []
    for attempt in attempts:
        slot = match_user_slot(user_slots, attempt)
        result = attempt.get("result") if isinstance(attempt.get("result"), dict) else {}
        attempt_seat = normalize_text(attempt.get("seatNum"), 80)
        primary_seats = slot.get("primary") or []
        backup_seats = slot.get("backup") or []
        success = bool(result.get("success") is True)
        message = normalize_text(result.get("msg") if isinstance(result, dict) else "", 240)
        final_attempt_seat = success_seat_from_attempt(attempt) if success else ""
        source_seat = final_attempt_seat if success else attempt_seat
        source = "primary" if source_seat and source_seat in primary_seats else "backup" if source_seat and source_seat in backup_seats else "unknown"
        location = success_location_from_attempt(attempt) if success else {}
        if success:
            result_text = "首抢成功" if source == "primary" else "备选成功" if source == "backup" else "成功"
        else:
            result_text = message or "未成功"
        attempt_results.append(
            {
                "time": normalize_text(attempt.get("time") or slot.get("time"), 80),
                "primarySeat": unique_join(primary_seats) or attempt_seat,
                "backupSeat": unique_join(backup_seats),
                "finalSeat": final_attempt_seat,
                "attemptSeat": attempt_seat,
                "actualRoomId": success_room_from_attempt(attempt) if success else "",
                "actualSeat": final_attempt_seat,
                "firstLevelName": location.get("firstLevelName", ""),
                "secondLevelName": location.get("secondLevelName", ""),
                "thirdLevelName": location.get("thirdLevelName", ""),
                "result": result_text,
                "success": success,
                "source": source,
                "message": message,
            }
        )

    visible_slots = [slot for slot in user_slots if slot.get("time") or slot.get("primary")]
    if not visible_slots and attempt_results:
        seen_times: set[str] = set()
        visible_slots = []
        for attempt_result in attempt_results:
            time_key = normalize_text(attempt_result.get("time"), 80) or normalize_text(attempt_result.get("attemptSeat"), 80)
            if not time_key or time_key in seen_times:
                continue
            seen_times.add(time_key)
            visible_slots.append({"time": attempt_result.get("time") or "", "roomId": "", "primary": [attempt_result.get("primarySeat") or attempt_result.get("attemptSeat")], "backup": []})

    time_slot_results: list[dict] = []
    for slot in visible_slots:
        slot_time = normalize_text(slot.get("time"), 80)
        primary_seats = slot.get("primary") or []
        backup_seats = slot.get("backup") or []
        related_attempts = [
            attempt
            for attempt in attempt_results
            if (slot_time and attempt.get("time") == slot_time)
            or (not slot_time and attempt.get("attemptSeat") in primary_seats + backup_seats)
        ]
        success_detail = next((attempt for attempt in related_attempts if attempt.get("success")), None)
        last_detail = related_attempts[-1] if related_attempts else {}
        final_detail = success_detail or last_detail
        final_source = normalize_text(final_detail.get("source"), 30)
        success = bool(success_detail)
        if success:
            result_text = "首抢成功" if final_source == "primary" else "备选成功" if final_source == "backup" else "成功"
            final_slot_seat = normalize_text(final_detail.get("finalSeat") or final_detail.get("attemptSeat"), 80)
        elif related_attempts:
            result_text = normalize_text(final_detail.get("message") or final_detail.get("result"), 240) or "未成功"
            final_slot_seat = ""
        else:
            result_text = "未提交"
            final_slot_seat = ""
        time_slot_results.append(
            {
                "time": slot_time,
                "primarySeat": unique_join(primary_seats),
                "backupSeat": unique_join(backup_seats),
                "finalSeat": final_slot_seat,
                "attemptSeat": normalize_text(final_detail.get("attemptSeat"), 80),
                "actualRoomId": normalize_text(final_detail.get("actualRoomId"), 80),
                "actualSeat": normalize_text(final_detail.get("actualSeat") or final_slot_seat, 80),
                "firstLevelName": normalize_text(final_detail.get("firstLevelName"), 120),
                "secondLevelName": normalize_text(final_detail.get("secondLevelName"), 120),
                "thirdLevelName": normalize_text(final_detail.get("thirdLevelName"), 120),
                "result": result_text,
                "success": success,
                "source": final_source,
                "message": normalize_text(final_detail.get("message"), 240),
            }
        )

    configured_slot_count = len([slot for slot in user_slots if slot.get("time") or slot.get("primary")])
    success_slots = [slot for slot in time_slot_results if slot.get("success")]
    backup_success_slots = [slot for slot in success_slots if slot.get("source") == "backup"]
    failed_slots = [slot for slot in time_slot_results if not slot.get("success")]

    primary_result = "unknown"
    backup_result = "skipped"
    status = "failed"
    error_code = ""
    if success_slots:
        all_success = configured_slot_count == 0 or len(success_slots) >= configured_slot_count or not failed_slots
        if backup_success_slots:
            status = "backup_success" if all_success else "partial_success"
            primary_result = "部分失败" if failed_slots else "部分使用备选"
            backup_result = "success"
            final_reason = f"抢座成功：{len(success_slots)}个时间段成功，其中{len(backup_success_slots)}个使用备选座位，最终座位{final_seat or '未识别'}"
        elif all_success:
            status = "primary_success"
            primary_result = "success"
            backup_result = "skipped"
            if configured_slot_count > 1:
                final_reason = f"抢座成功：{len(success_slots)}个时间段全部为首抢座位成功，最终座位{final_seat or '未识别'}"
            else:
                final_reason = f"抢座成功：首抢座位{final_seat or primary or '未识别'}预约成功"
        else:
            status = "partial_success"
            primary_result = "部分成功"
            backup_result = "skipped"
            final_reason = f"部分抢座成功：{len(success_slots)}个时间段成功，{len(failed_slots)}个时间段未成功，最终座位{final_seat or '未识别'}"
    else:
        primary_result = "failed"
        backup_result = "failed" if backup else "skipped"
        message = last_failure_message(attempts, log_text)
        error_code, final_reason = classify_failure(log_text, message, returncode)

    task_id = "_".join(
        part
        for part in [
            normalize_text(summary.get("run_id") or run_dir.name, 80),
            str(index or "0"),
            school_id,
            user_id or account,
        ]
        if part
    )
    debug_brief = format_admin_timeline(admin_timeline)
    if not debug_brief:
        debug_lines = []
        for line in log_text.splitlines():
            lower = line.lower()
            if any(key in lower for key in ["error", "warning", "captcha", "success", "reserved", "conflict", "login", "非法", "失败"]):
                debug_lines.append(sanitize_admin_log_line(line))
        debug_brief = "\n".join(debug_lines[-12:])

    return {
        "task_id": task_id,
        "batch_id": normalize_text(summary.get("run_id") or run_dir.name, 120),
        "server_id": server_id,
        "school_id": school_id,
        "user_id": user_id,
        "account": account,
        "account_masked": account_masked,
        "reserve_date": reserve_date,
        "status": status,
        "error_code": error_code,
        "primary_seat": primary,
        "backup_seat": backup,
        "primary_result": primary_result,
        "backup_result": backup_result,
        "final_seat": final_seat,
        "final_reason": final_reason,
        "debug_brief": normalize_text(debug_brief, 4000),
        "started_at": normalize_text(item.get("started_at") or summary.get("started_at"), 80),
        "finished_at": normalize_text(item.get("finished_at") or summary.get("finished_at"), 80),
        "admin_timeline": admin_timeline,
        "raw": {
            "nickname": nickname,
            "time_slots": time_slot_results,
            "attempts": attempt_results[-40:],
            "first_primary_conflict": first_primary_conflict,
            "configured_slots": [
                {
                    "time": slot.get("time") or "",
                    "roomId": slot.get("roomId") or "",
                    "primarySeat": unique_join(slot.get("primary") or []),
                    "backupSeat": unique_join(slot.get("backup") or []),
                }
                for slot in user_slots
            ],
            "attempted_slot_count": len([slot for slot in time_slot_results if slot.get("attemptSeat")]),
            "successful_slot_count": len(success_slots),
            "configured_slot_count": configured_slot_count,
            "admin_timeline": admin_timeline,
        },
    }


def post_json(url: str, token: str, payload: dict, timeout: float) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-Result-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            parsed = json.loads(body) if body else {}
            parsed["_httpStatus"] = getattr(resp, "status", 0)
            return parsed
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        return {"ok": False, "status": exc.code, "error": detail[:500]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def write_results_to_local_db(results: list[dict]) -> dict:
    from server_store.db import connect, init_db
    from server_store.result_repository import cleanup_expired_results, upsert_result

    init_db()
    conn = connect()
    accepted: list[str] = []
    try:
        cleanup_expired_results(conn)
        for result in results:
            accepted.append(upsert_result(conn, result))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        return {"ok": False, "error": str(exc), "accepted": accepted, "mode": "local-db"}
    finally:
        conn.close()
    return {"ok": True, "accepted": accepted, "mode": "local-db"}


def process_run(run_dir: pathlib.Path, server_id: str) -> tuple[list[dict], dict]:
    summary = load_json(run_dir / "summary.json", {})
    payload = load_json(run_dir / "payload.json", {})
    results = []
    for item in summary.get("results") or []:
        if isinstance(item, dict):
            results.append(build_result(run_dir, summary, payload, item, server_id))
    processed = {
        "ok": True,
        "runId": normalize_text(summary.get("run_id") or run_dir.name, 120),
        "processedAt": beijing_now().isoformat(),
        "resultCount": len(results),
        "results": results,
    }
    save_json(run_dir / PROCESSED_RESULTS_FILE, processed)
    return results, processed


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse local server_runs logs and report user-readable reserve results")
    parser.add_argument("--project-root", default=os.getenv("SERVER_PROJECT_ROOT", DEFAULT_PROJECT_ROOT))
    parser.add_argument("--date", default=os.getenv("RESERVE_RESULT_REPORT_DATE", ""), help="Beijing date YYYY-MM-DD; defaults to today")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="Report runs even when result_report_state.json says they were sent")
    parser.add_argument("--run-dir", default="", help="Process a single server_runs/<run_id> directory")
    args = parser.parse_args()

    project_root = pathlib.Path(args.project_root).expanduser().resolve()
    runs_dir = project_root / "server_runs"
    center_url = normalize_text(os.getenv("RESERVE_RESULT_CENTER_URL") or DEFAULT_RESULT_CENTER_URL, 300).rstrip("/")
    token = normalize_text(os.getenv("RESERVE_RESULT_REPORT_TOKEN"), 500)
    server_id = normalize_text(os.getenv("RESERVE_RESULT_SERVER_ID") or socket.gethostname(), 120)
    timeout = float(os.getenv("RESERVE_RESULT_REPORT_TIMEOUT", "8") or "8")
    local_db_mode = env_flag_enabled("ENABLE_RESERVE_RESULT_CENTER") or env_flag_enabled("RESERVE_RESULT_LOCAL_WRITE")

    if args.run_dir:
        run_dirs = [pathlib.Path(args.run_dir).expanduser().resolve()]
    else:
        report_date = None
        if args.date:
            try:
                report_date = dt.date.fromisoformat(args.date)
            except ValueError:
                print(f"Invalid --date value: {args.date}", file=sys.stderr)
                return 2
        run_dirs = iter_today_run_dirs(runs_dir, report_date)

    all_results: list[dict] = []
    processed_runs: list[dict] = []
    skipped_runs: list[str] = []
    for run_dir in run_dirs:
        state_path = run_dir / REPORT_STATE_FILE
        state = load_json(state_path, {})
        if state.get("reported") is True and not args.force:
            skipped_runs.append(run_dir.name)
            continue
        results, processed = process_run(run_dir, server_id)
        all_results.extend(results)
        processed_runs.append({"runId": run_dir.name, "resultCount": len(results)})

    if args.dry_run:
        print(json.dumps({"ok": True, "dryRun": True, "runs": processed_runs, "results": all_results}, ensure_ascii=False, indent=2))
        return 0

    if not all_results:
        print(json.dumps({"ok": True, "message": "no pending results", "skippedRuns": skipped_runs}, ensure_ascii=False))
        return 0
    if local_db_mode:
        response = write_results_to_local_db(all_results)
    elif not token:
        print("RESERVE_RESULT_REPORT_TOKEN is required", file=sys.stderr)
        return 2
    else:
        payload = {
            "server_id": server_id,
            "batch_id": f"{server_id}_{beijing_now().strftime('%Y%m%d_%H%M%S')}",
            "results": all_results,
        }
        response = post_json(f"{center_url}/api/reserve-results/batch-report", token, payload, timeout)
    ok = bool(response.get("ok"))
    reported_ids = set(response.get("accepted") or [])
    for run in processed_runs:
        run_dir = runs_dir / run["runId"]
        run_results = load_json(run_dir / PROCESSED_RESULTS_FILE, {}).get("results") or []
        run_ids = {item.get("task_id") for item in run_results if isinstance(item, dict)}
        reported = ok and run_ids.issubset(reported_ids)
        save_json(
            run_dir / REPORT_STATE_FILE,
            {
                "reported": reported,
                "reportedAt": beijing_now().isoformat() if reported else "",
                "resultCount": len(run_ids),
                "response": response,
            },
        )

    print(json.dumps({"ok": ok, "runs": processed_runs, "skippedRuns": skipped_runs, "response": response}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
