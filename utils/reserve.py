from utils import AES_Encrypt, enc, generate_captcha_key, verify_param
import json
import requests
import re
import time
import logging
import datetime
import os
from urllib3.exceptions import InsecureRequestWarning

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv not installed, use system environment variables instead


def _should_save_captcha_debug_images() -> bool:
    """是否保存验证码图片到本地，默认关闭。"""
    return os.getenv("SAVE_CAPTCHA_DEBUG_IMAGES", "0").lower() in {"1", "true", "yes", "on"}


def _get_tulingcloud_config():
    """从环境变量或 config.json 获取图灵云配置。
    
    优先级：
    1. 环境变量（GitHub Actions）
    2. config.json（本地开发）
    
    返回:
        (username, password, model_id) 元组，如果未配置则返回空字符串
    """
    # 优先从环境变量读取
    username = os.getenv("TULINGCLOUD_USERNAME", "")
    password = os.getenv("TULINGCLOUD_PASSWORD", "")
    model_id = os.getenv("TULINGCLOUD_MODEL_ID", "")
    
    # 如果环境变量中没有，尝试从 config.json 读取
    if not all([username, password, model_id]):
        try:
            config_path = os.path.join(os.path.dirname(__file__), "..", "config.json")
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
                    tuling_config = config.get("tulingcloud", {})
                    username = username or tuling_config.get("username", "")
                    password = password or tuling_config.get("password", "")
                    model_id = model_id or tuling_config.get("model_id", "")
        except Exception as e:
            logging.debug(f"Failed to read tulingcloud config from config.json: {e}")
    
    return username, password, model_id


def get_date(day_offset: int = 0):
    """基于北京时间获取日期字符串，避免时区混乱。"""
    beijing_today = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()
    offset_day = beijing_today + datetime.timedelta(days=day_offset)
    return offset_day.strftime("%Y-%m-%d")


class reserve:
    def __init__(
        self,
        sleep_time=0.2,
        max_attempt=50,
        enable_slider=False,
        enable_textclick=False,
        reserve_next_day=False,
    ):
        self.login_page = (
            "https://passport2.chaoxing.com/mlogin?loginType=1&newversion=true&fid="
        )
        # 使用 seatengine 选座页面来获取 submit_enc，与前端行为保持一致
        # 使用命名占位符，包含 roomId/day/seatPageId/fidEnc 四个参数
        # 结构与浏览器中实际 URL 对齐：
        # /front/third/apps/seatengine/select?id=864&day=YYYY-MM-DD&backLevel=2&seatId=602&fidEnc=...
        self.url = (
            "https://office.chaoxing.com/front/third/apps/seatengine/select?"
            "id={roomId}&day={day}&backLevel=2&seatId={seatPageId}&fidEnc={fidEnc}"
        )
        # 使用新版 seatengine 提交接口，与前端保持一致
        self.submit_url = "https://office.chaoxing.com/data/apps/seatengine/submit"
        self.seat_url = "https://office.chaoxing.com/data/apps/seatengine/getusedtimes"
        self.login_url = "https://passport2.chaoxing.com/fanyalogin"
        self.token = ""
        self.success_times = 0
        self.fail_dict = []
        self.submit_msg = []
        self.last_submit_result = None
        self.requests = requests.session()
        self.request_timeout = (
            float(os.getenv("CX_CONNECT_TIMEOUT", "3.05")),
            float(os.getenv("CX_READ_TIMEOUT", "5")),
        )
        self.request_attempts = max(1, int(os.getenv("CX_REQUEST_ATTEMPTS", "3")))
        self.request_retry_delay = float(os.getenv("CX_REQUEST_RETRY_DELAY", "0.2"))
        self.headers = {
            "Referer": "https://office.chaoxing.com/",
            "Host": "captcha.chaoxing.com",
            "Pragma": "no-cache",
            "Sec-Ch-Ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Linux"',
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        }
        self.login_headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "accept-encoding": "gzip, deflate, br, zstd",
            "cache-control": "no-cache",
            "Connection": "keep-alive",
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.3 (KHTML, like Gecko) Version/10.0 Mobile/14E304 Safari/602.1 wechatdevtools/1.05.2109131 MicroMessenger/8.0.5 Language/zh_CN webview/16364215743155638",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Host": "passport2.chaoxing.com",
        }

        self.sleep_time = sleep_time
        self.max_attempt = max_attempt
        self.enable_slider = enable_slider
        self.enable_textclick = enable_textclick
        self.reserve_next_day = reserve_next_day
        requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

    @staticmethod
    def _is_terminal_submit_failure(msg: str) -> bool:
        return "已有预约" in msg or "已被占用" in msg

    def should_skip_followup_submit(self) -> bool:
        if not isinstance(self.last_submit_result, dict):
            return False
        msg = str(self.last_submit_result.get("msg", ""))
        return self._is_terminal_submit_failure(msg)

    def _request_with_retry(
        self,
        method,
        url,
        *,
        request_name="request",
        attempts=None,
        retry_delay=None,
        **kwargs,
    ):
        attempts = attempts if attempts is not None else self.request_attempts
        retry_delay = (
            retry_delay if retry_delay is not None else self.request_retry_delay
        )
        if "timeout" not in kwargs:
            kwargs["timeout"] = self.request_timeout

        last_exc = None
        for attempt in range(1, attempts + 1):
            try:
                return self.requests.request(method=method, url=url, **kwargs)
            except requests.exceptions.RequestException as exc:
                last_exc = exc
                if attempt >= attempts:
                    logging.error(
                        f"{request_name} failed after {attempts} attempt(s): {exc}"
                    )
                    raise
                logging.warning(
                    f"{request_name} failed on attempt {attempt}/{attempts}: {exc}; "
                    f"retrying in {retry_delay:.2f}s"
                )
                time.sleep(retry_delay)

        raise last_exc

    def _get(self, url, **kwargs):
        return self._request_with_retry("GET", url, **kwargs)

    def _post(self, url, **kwargs):
        return self._request_with_retry("POST", url, **kwargs)

    # login and page token
    def _get_page_token(self, url, require_value: bool = False, method: str = "GET", data=None):
        """从页面提取提交用的 token。

        新版页面只有一个隐藏字段 submit_enc，不再有单独的 algorithm。
        实测行为是：submit_enc 既作为页面 token，也作为 enc 算法的"算法值"。
        因此这里直接用 submit_enc 作为两者。

        参数:
            url: seatengine/select 页面地址
            require_value: 是否返回算法值（即 submit_enc 本身）
            method: "GET" 或 "POST"，允许按前端实现切换请求方式
            data: 当使用 POST 时提交的表单数据
        """
        try:
            if method.upper() == "POST":
                response = self._post(
                    url=url,
                    data=data or {},
                    verify=False,
                    request_name="seat page token fetch",
                )
            else:
                response = self._get(
                    url=url,
                    verify=False,
                    request_name="seat page token fetch",
                )
        except requests.exceptions.RequestException as e:
            logging.warning(f"Failed to fetch seat page token from {url}: {e}")
            return "", ""

        # 统一按 UTF-8 解码，并忽略非法字符，避免 charset 识别错误导致正则匹配失败
        html = response.content.decode("utf-8", errors="ignore")

        # token 在隐藏 input 中，属性顺序和引号类型可能变化，这里做更宽松的匹配
        # 例如：<input type="hidden" id="submit_enc" value="..."/>
        # 注意：这里需要匹配 id/name 后面的等号和可选空格
        token_matches = re.findall(
            r'(?:id|name)\s*=\s*["\']submit_enc["\'][^>]*?value\s*=\s*["\'](.*?)["\']',
            html,
        )
        if not token_matches:
            # 取不到 token 时：
            # 1. 控制台打印部分页面内容
            # 2. 将完整 HTML 保存到 html_debug 目录，方便你用浏览器打开对比前端结构
            snippet = html[:500].replace("\n", " ")
            logging.error(f"Failed to get token from {url}, html snippet: {snippet}...")
            try:
                debug_dir = os.path.join(os.path.dirname(__file__), "..", "html_debug")
                os.makedirs(debug_dir, exist_ok=True)
                ts = int(time.time() * 1000)
                filename = os.path.join(debug_dir, f"seatengine_{ts}.html")
                with open(filename, "w", encoding="utf-8") as f:
                    f.write(html)
                logging.error(f"Full HTML of seatengine page saved to {filename}")
            except Exception as e:
                logging.warning(f"Failed to save debug HTML for seatengine page: {e}")
            return "", ""

        token = token_matches[0]
        # 现在页面没有单独的 algorithm 字段，直接复用 submit_enc
        algorithm_value = token if require_value else ""
        return token, algorithm_value

    def warm_connection(self, url):
        """预热 TCP+TLS 连接池。

        发送一次和获取 token 完全相同的真实 GET 请求，结果直接丢弃。
        requests.Session 底层使用 urllib3 连接池，相同 host 的后续请求可复用已建立的连接，
        跳过 TCP 三次握手 + TLS 协商，节省约 100-200ms。
        """
        try:
            self._get(
                url=url,
                verify=False,
                timeout=5,
                attempts=1,
                request_name="[warm] connection pre-warm",
            )
            logging.info(f"[warm] Connection pre-warmed via {url}")
        except Exception as e:
            logging.warning(f"[warm] Failed to warm connection: {e}")

    def get_login_status(self, attempts=None):
        self.requests.headers = self.login_headers
        self._get(
            url=self.login_page,
            verify=False,
            request_name="login page bootstrap",
            attempts=attempts,
        )

    def login(self, username, password, attempts=None):
        username = AES_Encrypt(username)
        password = AES_Encrypt(password)
        parm = {
            "fid": -1,
            "uname": username,
            "password": password,
            "refer": "http%3A%2F%2Foffice.chaoxing.com%2Ffront%2Fthird%2Fapps%2Fseat%2Fcode%3Fid%3D4219%26seatNum%3D380",
            "t": True,
        }
        response = self._post(
            url=self.login_url,
            params=parm,
            verify=False,
            request_name="Chaoxing login submit",
            attempts=attempts,
        )
        try:
            obj = response.json()
        except ValueError as e:
            logging.error(f"Failed to parse Chaoxing login response: {e}")
            return (False, "invalid login response")
        if obj["status"]:
            logging.info(f"User {username} login successfully")
            return (True, "")
        else:
            logging.info(
                f"User {username} login failed. Please check you password and username! "
            )
            return (False, obj["msg2"])

    def bootstrap_login(self, username, password, attempts=None):
        """建立登录态；遇到短暂网络错误时返回 False，由外层继续调度。"""
        try:
            self.get_login_status(attempts=attempts)
            success, msg = self.login(username, password, attempts=attempts)
        except requests.exceptions.RequestException as e:
            logging.warning(f"Failed to bootstrap login session for {username}: {e}")
            return False

        if not success:
            logging.warning(f"Login bootstrap rejected for {username}: {msg}")
            return False

        self.requests.headers.update({"Host": "office.chaoxing.com"})
        return True

    # extra: get roomid
    def roomid(self, encode):
        url = f"https://office.chaoxing.com/data/apps/seat/room/list?cpage=1&pageSize=100&firstLevelName=&secondLevelName=&thirdLevelName=&deptIdEnc={encode}"
        json_data = self._get(url=url, request_name="room list fetch").content.decode("utf-8")
        try:
            ori_data = json.loads(json_data)
        except ValueError as e:
            logging.error(f"Failed to parse room list response: {e}")
            return
        for i in ori_data["data"]["seatRoomList"]:
            info = f'{i["firstLevelName"]}-{i["secondLevelName"]}-{i["thirdLevelName"]} id为：{i["id"]}'
            print(info)

    # solve captcha

    def resolve_captcha(self, captcha_type="slide"):
        """统一的验证码求解入口。
        
        参数:
            captcha_type: "slide"（滑块）或 "textclick"（选字）
        """
        if captcha_type == "slide":
            return self._resolve_slide_captcha()
        elif captcha_type == "textclick":
            return self._resolve_textclick_captcha()
        else:
            logging.error(f"Unknown captcha type: {captcha_type}")
            return ""

    def _resolve_slide_captcha(self):
        """滑块验证码求解。"""
        logging.info(f"Start to resolve slide captcha token")
        captcha_token, bg, tp = self.get_slide_captcha_data()
        if not captcha_token or not bg or not tp:
            logging.warning("Failed to get slide captcha payload")
            return ""
        logging.info(f"Successfully get prepared captcha_token {captcha_token}")
        logging.info(f"Captcha Image URL-small {tp}, URL-big {bg}")
        x = self.x_distance(bg, tp)
        if x is None:
            logging.warning("Failed to download or parse slide captcha images")
            return ""
        logging.info(f"Successfully calculate the captcha distance {x}")

        return self._submit_captcha("slide", captcha_token, [{"x": x}])

    def _resolve_textclick_captcha(self):
        """选字验证码求解。"""
        logging.info("Start to resolve textclick captcha token")
        captcha_token, image_url, target_text = self.get_textclick_captcha_data()
        if not captcha_token or not image_url:
            logging.warning("Failed to get textclick captcha payload")
            return ""
        logging.info(f"Successfully get prepared captcha_token {captcha_token}")
        logging.info(f"Target text: {target_text}")
        
        # 使用颜色分割检测字位置
        positions = self._recognize_textclick_positions(image_url, target_text)
        if not positions:
            logging.warning("Failed to recognize text positions")
            return ""
        
        logging.info(f"Successfully recognize positions: {positions}")
        
        # 尝试控法提交，目前不能100%保证页序正确
        # 所以放记了目前的应对数序验证，直接提交
        return self._submit_captcha("textclick", captcha_token, positions)

    def _submit_captcha(self, captcha_type, captcha_token, click_array):
        """统一的验证码提交逻辑。
        
        参数:
            captcha_type: "slide" 或 "textclick"
            captcha_token: 验证码 token
            click_array: [{"x": x}] 或 [{"x": x1, "y": y1}, ...]
        """
        params = {
            "callback": "jQuery33109180509737430778_1716381333117",
            "captchaId": "42sxgHoTPTKbt0uZxPJ7ssOvtXr3ZgZ1",
            "type": captcha_type,
            "token": captcha_token,
            "textClickArr": json.dumps(click_array),
            "coordinate": json.dumps([]),
            "runEnv": "10",
            "version": "1.1.20" if captcha_type == "textclick" else "1.1.18",
            "_": int(time.time() * 1000),
        }
        logging.debug(f"Submit captcha params: {params}")
        try:
            response = self._get(
                f"https://captcha.chaoxing.com/captcha/check/verification/result",
                params=params,
                headers=self.headers,
                request_name=f"{captcha_type} captcha submit",
            )
        except requests.exceptions.RequestException as e:
            logging.warning(f"Failed to submit {captcha_type} captcha: {e}")
            return ""
        text = response.text.replace(
            "jQuery33109180509737430778_1716381333117(", ""
        ).replace(")", "")
        try:
            data = json.loads(text)
        except ValueError as e:
            logging.error(f"Failed to parse {captcha_type} captcha response: {e}")
            return ""
        logging.info(f"Successfully resolve the captcha token: {data}")
        try:
            validate_val = json.loads(data["extraData"])["validate"]
            return validate_val
        except (KeyError, ValueError) as e:
            logging.info("Can't load validate value. Maybe server return mistake.")
            return ""

    def get_textclick_captcha_data(self):
        """获取选字验证码数据。"""
        url = "https://captcha.chaoxing.com/captcha/get/verification/image"
        timestamp = int(time.time() * 1000)
        capture_key, token = generate_captcha_key(timestamp, captcha_type="textclick")
        referer = f"https://office.chaoxing.com/front/third/apps/seat/code?id=3993&seatNum=0199"
        params = {
            "callback": "jQuery33107685004390294206_1716461324846",
            "captchaId": "42sxgHoTPTKbt0uZxPJ7ssOvtXr3ZgZ1",
            "type": "textclick",
            "version": "1.1.20",
            "captchaKey": capture_key,
            "token": token,
            "referer": referer,
            "_": timestamp,
            "d": "a",
            "b": "a",
        }
        try:
            response = self._get(
                url=url,
                params=params,
                headers=self.headers,
                request_name="textclick captcha fetch",
            )
        except requests.exceptions.RequestException as e:
            logging.warning(f"Failed to fetch textclick captcha data: {e}")
            return "", "", ""
        content = response.text

        data = content.replace(
            "jQuery33107685004390294206_1716461324846(", ""
        ).replace(")", "")
        try:
            data = json.loads(data)
        except ValueError as e:
            logging.error(f"Failed to parse textclick captcha payload: {e}")
            return "", "", ""
        captcha_token = data["token"]
        vo = data.get("imageVerificationVo", {})
        
        # 获取图片 URL 和目标文字
        image_url = vo.get("originImage") or vo.get("shadeImage") or ""
        # 目标文字格式："\"朝\" \"阳\" \"系\"" 或其他格式
        target_text = vo.get("context") or data.get("clickText") or ""
        
        return captcha_token, image_url, target_text

    def _recognize_textclick_positions(self, image_url, target_text):
        """识别选字验证码中的文字位置。
        
        使用图灵云打码平台进行OCR识别。
        
        参数:
            image_url: 验证码图片 URL
            target_text: 需要点击的文字（格式如：'"朝" "阳" "系"'）
            
        返回:
            按目标文字顺序的坐标列表：[{"x": x1, "y": y1}, {"x": x2, "y": y2}, {"x": x3, "y": y3}]
        """
        try:
            import urllib.request
            import os
            import time as _time
            from utils.tulingcloud_ocr import TulingCloudOCR
        except ImportError as e:
            logging.error(f"Missing required modules: {e}")
            return None
        
        # 下载验证码图片
        try:
            headers = {
                "Referer": "https://office.chaoxing.com/",
                "User-Agent": self.headers["User-Agent"],
            }
            req = urllib.request.Request(image_url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                img_bytes = response.read()
        except Exception as e:
            logging.error(f"Failed to download captcha image: {e}")
            return None
        
        # 可选调试：默认不落盘，避免影响关键路径时延
        if _should_save_captcha_debug_images():
            try:
                ts = int(_time.time() * 1000)
                debug_dir = os.path.join(os.path.dirname(__file__), "..", "captcha_debug")
                os.makedirs(debug_dir, exist_ok=True)
                img_path = os.path.join(debug_dir, f"textclick_{ts}.jpg")
                with open(img_path, "wb") as f:
                    f.write(img_bytes)
                logging.debug(f"Saved textclick captcha image to {img_path}")
            except Exception as e:
                logging.debug(f"Failed to save captcha image: {e}")
        
        # 使用图灵云打码平台进行OCR识别
        try:
            # 从环境变量或 config.json 读取图灵云凭证
            tuling_username, tuling_password, tuling_model_id = _get_tulingcloud_config()
            
            if not all([tuling_username, tuling_password, tuling_model_id]):
                logging.error("TulingCloud credentials not properly configured")
                logging.error("Set TULINGCLOUD_USERNAME, TULINGCLOUD_PASSWORD, TULINGCLOUD_MODEL_ID in env or config.json")
                return None
            
            logging.debug(f"TulingCloud config - username: {tuling_username[:6]}..., model_id: {tuling_model_id}")
            
            ocr = TulingCloudOCR(
                username=tuling_username,
                password=tuling_password,
                model_id=tuling_model_id
            )
            
            # 调用打码平台进行OCR识别
            ocr_result = ocr.recognize_textclick(img_bytes)
            
            if not ocr_result:
                logging.warning("TulingCloud failed to recognize text")
                return None
            
            # 处理返回结果（可能是字典或字符串）
            if isinstance(ocr_result, dict):
                recognized_text = ocr_result.get("text", "")
                coordinates = ocr_result.get("coordinates")
            else:
                recognized_text = ocr_result
                coordinates = None
            
            if not recognized_text:
                logging.warning("TulingCloud returned empty text")
                return None
            
            logging.info(f"TulingCloud recognized text: {recognized_text}")
            logging.info(f"Target text to find: {target_text}")
            
            if not coordinates:
                logging.error(f"TulingCloud did not return coordinates")
                return None
            
            # 解析目标文字格式: " "" 业" """ "" 为单个字节）
            # 例子: '" \u5730" "\u5927" "\u4efb"' -> ['\u5730', '\u5927', '\u4efb']
            target_chars = []
            i = 0
            while i < len(target_text):
                if target_text[i] == '"':
                    # 找下一个双引号
                    j = i + 1
                    while j < len(target_text) and target_text[j] != '"':
                        j += 1
                    if j < len(target_text):
                        target_chars.append(target_text[i+1:j])
                        i = j + 1
                    else:
                        i += 1
                else:
                    i += 1
            
            logging.info(f"Parsed target characters: {target_chars}")
            
            # 从图灵云的识别结果中找到目标字符的坐标
            result_positions = []
            used_indices = set()  # 记录已使用的索引，避免重复匹配同一个字符
            
            for target_char in target_chars:
                # 在识别的文字中找该字符（跳过已使用的索引）
                found = False
                for idx, recognized_char in enumerate(recognized_text):
                    if recognized_char == target_char and idx < len(coordinates) and idx not in used_indices:
                        result_positions.append(coordinates[idx])
                        used_indices.add(idx)
                        logging.info(f"Found target '{target_char}' at position {idx}: {coordinates[idx]}")
                        found = True
                        break
                
                if not found:
                    # 如果有任何一个目标字符找不到，直接丢弃本次识别结果，返回 None
                    logging.warning(f"Target character '{target_char}' not found in recognized text '{recognized_text}'")
                    logging.warning(f"Discarding this captcha recognition, will retry with new captcha")
                    return None
            
            # 确保找到了所有目标字符
            if len(result_positions) == len(target_chars):
                logging.info(f"Final positions for target {target_chars}: {result_positions}")
                return result_positions
            else:
                logging.error(f"Could not find all target characters. Found {len(result_positions)}/{len(target_chars)}")
                return None
            
        except Exception as e:
            logging.error(f"FateADM recognition failed: {e}")
            import traceback
            logging.debug(traceback.format_exc())
            return None

    def get_slide_captcha_data(self):
        url = "https://captcha.chaoxing.com/captcha/get/verification/image"
        timestamp = int(time.time() * 1000)
        capture_key, token = generate_captcha_key(timestamp)
        referer = f"https://office.chaoxing.com/front/third/apps/seat/code?id=3993&seatNum=0199"
        params = {
            "callback": f"jQuery33107685004390294206_1716461324846",
            "captchaId": "42sxgHoTPTKbt0uZxPJ7ssOvtXr3ZgZ1",
            "type": "slide",
            "version": "1.1.18",
            "captchaKey": capture_key,
            "token": token,
            "referer": referer,
            "_": timestamp,
            "d": "a",
            "b": "a",
        }
        try:
            response = self._get(
                url=url,
                params=params,
                headers=self.headers,
                request_name="slide captcha fetch",
            )
        except requests.exceptions.RequestException as e:
            logging.warning(f"Failed to fetch slide captcha data: {e}")
            return "", "", ""
        content = response.text

        data = content.replace(
            "jQuery33107685004390294206_1716461324846(", ")"
        ).replace(")", "")
        try:
            data = json.loads(data)
        except ValueError as e:
            logging.error(f"Failed to parse slide captcha payload: {e}")
            return "", "", ""
        captcha_token = data["token"]
        bg = data["imageVerificationVo"]["shadeImage"]
        tp = data["imageVerificationVo"]["cutoutImage"]
        return captcha_token, bg, tp

    def x_distance(self, bg, tp):
        import numpy as np
        import cv2
        import os
        import time as _time

        def cut_slide(slide):
            slider_array = np.frombuffer(slide, np.uint8)
            slider_image = cv2.imdecode(slider_array, cv2.IMREAD_UNCHANGED)
            slider_part = slider_image[:, :, :3]
            mask = slider_image[:, :, 3]
            mask[mask != 0] = 255
            x, y, w, h = cv2.boundingRect(mask)
            cropped_image = slider_part[y : y + h, x : x + w]
            return cropped_image

        c_captcha_headers = {
            "Referer": "https://office.chaoxing.com/",
            "Host": "captcha-b.chaoxing.com",
            "Pragma": "no-cache",
            "Sec-Ch-Ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Linux"',
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        }

        def _download_image_with_retry(url: str, label: str, max_retries: int = 3, timeout_s: float = 5.0):
            for attempt in range(1, max_retries + 1):
                started = _time.time()
                try:
                    resp = self._get(
                        url,
                        headers=c_captcha_headers,
                        timeout=timeout_s,
                        attempts=1,
                        request_name=f"{label} image download",
                    )
                    resp.raise_for_status()
                    elapsed = _time.time() - started
                    if elapsed > timeout_s:
                        logging.warning(
                            f"{label} image download exceeded {timeout_s}s on attempt {attempt} "
                            f"({elapsed:.3f}s), retrying"
                        )
                        continue
                    return resp.content
                except requests.exceptions.Timeout:
                    logging.warning(
                        f"{label} image download timeout (> {timeout_s}s), retry {attempt}/{max_retries}"
                    )
                except Exception as e:
                    logging.warning(
                        f"{label} image download failed on retry {attempt}/{max_retries}: {e}"
                    )
            return None

        bg_bytes = _download_image_with_retry(bg, "Background")
        tp_bytes = _download_image_with_retry(tp, "Puzzle")
        if not bg_bytes or not tp_bytes:
            logging.error("Slide captcha image download failed after retries")
            return None

        # 可选调试：默认不落盘，避免频繁 IO 和日志噪音
        if _should_save_captcha_debug_images():
            try:
                ts = int(_time.time() * 1000)
                debug_dir = os.path.join(os.path.dirname(__file__), "..", "captcha_debug")
                os.makedirs(debug_dir, exist_ok=True)
                bg_path = os.path.join(debug_dir, f"bg_{ts}.jpg")
                tp_path = os.path.join(debug_dir, f"tp_{ts}.png")
                with open(bg_path, "wb") as f:
                    f.write(bg_bytes)
                with open(tp_path, "wb") as f:
                    f.write(tp_bytes)
                logging.debug(f"Saved captcha images to {bg_path} and {tp_path}")
            except Exception as e:
                logging.debug(f"Failed to save captcha images: {e}")

        bg_img = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
        tp_img = cut_slide(tp_bytes)
        bg_edge = cv2.Canny(bg_img, 100, 200)
        tp_edge = cv2.Canny(tp_img, 100, 200)
        bg_pic = cv2.cvtColor(bg_edge, cv2.COLOR_GRAY2RGB)
        tp_pic = cv2.cvtColor(tp_edge, cv2.COLOR_GRAY2RGB)
        res = cv2.matchTemplate(bg_pic, tp_pic, cv2.TM_CCOEFF_NORMED)
        _, _, _, max_loc = cv2.minMaxLoc(res)
        tl = max_loc
        return tl[0]

    def submit(self, times, roomid, seatid, action, endtime_hms: str | None = None, fidEnc: str | None = None, seat_page_id: str | None = None):
        """提交预约。

        关键点：为了模拟手动“刷新页面再提交”，这里每次尝试前都会重新访问
        seatengine/select 页面，获取当下最新的 submit_enc 作为 token/algorithm。

        参数:
            times: [startTime, endTime]
            roomid: 房间 id
            seatid: 座位号列表
            action: 是否为 action 场景（保留原逻辑使用）
            endtime_hms: 结束时间（北京时间 HH:MM:SS），用于 GitHub Actions 提前停止
            fidEnc: 对应前端 URL 中的 fidEnc 参数（例如 "dac916902610d220"）
            seat_page_id: 对应前端 URL 中的 seatId 参数（例如 "3308"）
        """
        # 计算与 get_submit 相同的预约日期，保证页面 token 与提交使用的是同一天
        beijing_today = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).date()
        delta_day = 1 if self.reserve_next_day else 0
        day = beijing_today + datetime.timedelta(days=delta_day)
        
        # 每次调用 submit 时重置 max_attempt，确保每个配置都有充足的重试机会
        original_max_attempt = self.max_attempt

        for seat in seatid:
            # 为每个座位重置尝试次数
            self.max_attempt = original_max_attempt
            suc = False
            while ~suc and self.max_attempt > 0:
                # 如果配置了结束时间，并且在 GitHub Actions 模式下，达到或超过结束时间就立刻停止循环
                if endtime_hms and action:
                    beijing_now = datetime.datetime.utcnow() + datetime.timedelta(hours=8)
                    current_hms = beijing_now.strftime("%H:%M:%S")
                    if current_hms >= endtime_hms:
                        logging.info(
                            f"[submit] Current Beijing time {current_hms} >= ENDTIME {endtime_hms}, stop submit loop"
                        )
                        return suc

                # 使用 seatengine/select 页面获取 submit_enc，相当于手动刷新选座页
                page_url = self.url.format(
                    roomId=roomid,
                    day=str(day),
                    seatPageId=seat_page_id or "",
                    fidEnc=fidEnc or "",
                )
                # seatengine/select 页面在前端是通过 GET 打开的，这里也使用 GET，
                # 否则可能拿到的是错误页或不包含 submit_enc 的内容。
                token, value = self._get_page_token(
                    page_url,
                    require_value=True,
                    method="GET",
                )
                logging.info(f"Get token from {page_url}: {token}")
                # 如果没有拿到 token，通常说明当前会话已失效或页面结构有变，
                # 不再继续本轮提交，交给外层重新登录/重试。
                if not token:
                    logging.warning(
                        "No submit_enc token fetched, break current submit loop and retry with new session"
                    )
                    break

                # 根据开关决定使用哪种验证码（两种验证码可以同时开启）
                captcha = ""
                if self.enable_slider:
                    captcha = self.resolve_captcha("slide")
                    logging.info(f"Slider captcha token: {captcha}")
                elif self.enable_textclick:
                    captcha = self.resolve_captcha("textclick")
                    logging.info(f"Textclick captcha token: {captcha}")
                suc = self.get_submit(
                    self.submit_url,
                    times=times,
                    token=token,
                    roomid=roomid,
                    seatid=seat,
                    captcha=captcha,
                    action=action,
                    value=value,
                )
                if suc:
                    return suc
                time.sleep(self.sleep_time)
                self.max_attempt -= 1
        return suc

    def get_submit(
        self, url, times, token, roomid, seatid, captcha="", action=False, value=""
    ):
        # 统一以北京时间（UTC+8）的"今天"为基准，不再区分本地 / GitHub Actions，
        # 是否预约明天仅由 self.reserve_next_day 决定。
        beijing_today = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).date()
        delta_day = 1 if self.reserve_next_day else 0
        day = beijing_today + datetime.timedelta(days=delta_day)
        # 与前端保持一致：提交 roomId/startTime/endTime/day/seatNum/captcha/wyToken，再计算 enc
        # 按前端逻辑：wyToken 仅在开启网易风控时由 wyRiskObj.getToken() 生成；
        # 常规情况下为空字符串，这里保持一致，不再把 submit_enc 当作 wyToken 传给后端。
        parm = {
            "roomId": roomid,
            "startTime": times[0],
            "endTime": times[1],
            "day": str(day),
            "seatNum": seatid,
            "captcha": captcha,
            "wyToken": "",
        }
        logging.info(f"submit parameter (before enc) {parm} ")
        # 使用页面上的 submit_enc（value）作为算法值生成 enc
        parm["enc"] = verify_param(parm, value)
        logging.info(f"submit enc: {parm['enc']}")

        # 按前端行为采用表单提交（POST body），并关闭证书验证以避免告警
        try:
            response = self._post(
                url=url,
                data=parm,
                verify=False,
                request_name="seat submit",
            )
        except requests.exceptions.RequestException as e:
            logging.warning(f"Seat submit request failed: {e}")
            return False

        html = response.content.decode("utf-8")
        try:
            data = json.loads(html)
        except ValueError as e:
            logging.error(f"Failed to parse seat submit response: {e}; body={html[:200]}")
            return False
        self.last_submit_result = data
        self.submit_msg.append(times[0] + "~" + times[1] + ":  " + str(data))
        logging.info(data)

        # 特殊处理：服务器返回 302 错误码（"您在页面停留过久，本次操作安全验证已超时。请刷新后再提交预约(代码:302)"）
        # 实际抢座过程中，这类返回往往已经完成了预约，只是前端要求用户刷新页面。
        msg = str(data.get("msg", ""))
        if not data.get("success") and "代码:302" in msg:
            logging.warning(
                "Server returned timeout code 302, treat this as success according to script preference."
            )
            return True

        return data.get("success", False)

    def burst_submit_once(self, times, roomid, seatid, captcha, token, value):
        """单次提交，返回完整响应 dict，用于 1.8 秒高频窗口内的逻辑判断。

        注意：这里沿用新的 enc 生成方式，token 仅作为前端算法值 value 的来源，
        不再直接作为提交字段发送给后端。
        """
        beijing_today = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).date()
        delta_day = 1 if self.reserve_next_day else 0
        day = beijing_today + datetime.timedelta(days=delta_day)
        parm = {
            "roomId": roomid,
            "startTime": times[0],
            "endTime": times[1],
            "day": str(day),
            "seatNum": seatid,
            "captcha": captcha,
            "wyToken": "",
        }
        logging.info(f"[burst] submit parameter (before enc) {parm} ")
        parm["enc"] = verify_param(parm, value)
        try:
            response = self._post(
                url=self.submit_url,
                data=parm,
                verify=False,
                request_name="[burst] seat submit",
            )
        except requests.exceptions.RequestException as e:
            logging.warning(f"[burst] Seat submit request failed: {e}")
            return {"success": False, "msg": str(e)}

        html = response.content.decode("utf-8")
        try:
            data = json.loads(html)
        except ValueError as e:
            logging.error(f"[burst] Failed to parse seat submit response: {e}; body={html[:200]}")
            return {"success": False, "msg": "invalid submit response"}
        self.last_submit_result = data
        self.submit_msg.append(times[0] + "~" + times[1] + ":  " + str(data))
        logging.info(data)
        return data
