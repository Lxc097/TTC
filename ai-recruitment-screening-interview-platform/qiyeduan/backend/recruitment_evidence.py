"""Opt-in, bounded checks of candidate-supplied professional links.

Reachability never proves authorship, employment, or a resume claim. New source
types can be added as independent providers without changing screening logic.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ALLOWED_HOSTS = {"github.com", "gitlab.com", "gitee.com", "dev.to", "medium.com",
                 "arxiv.org", "doi.org", "juejin.cn", "blog.csdn.net"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def _safe_url(raw: str) -> tuple[str, str] | None:
    try:
        parsed = urllib.parse.urlsplit(raw.rstrip(".,;，。)）"))
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or host not in ALLOWED_HOSTS or parsed.port not in (None, 443):
            return None
        if parsed.username or parsed.password or len(raw) > 500:
            return None
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, parsed.query, "")), host
    except ValueError:
        return None


def verify_supplied_links(urls: list[str], consent: bool) -> list[dict]:
    items: list[dict] = []
    opener = urllib.request.build_opener(NoRedirect)
    for raw in list(dict.fromkeys(urls))[:5]:
        checked_at = time.time()
        safe = _safe_url(raw)
        result = {"source": "candidate_provided", "url": raw[:500],
                  "checkedAt": checked_at,
                  "relatedClaim": "候选人主动提供的职业作品链接；个人贡献待核实",
                  "verificationStatus": "not_checked", "details": "未进行外部核验。"}
        if not consent:
            items.append(result)
            continue
        if not safe:
            result["details"] = "未核验此链接；仅支持已列入安全清单的 HTTPS 职业作品平台。"
            items.append(result)
            continue
        url, host = safe
        result["url"] = url
        try:
            if host == "github.com":
                match = re.fullmatch(r"/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/?", urllib.parse.urlsplit(url).path)
                if match:
                    api_url = "https://api.github.com/repos/" + match.group(1) + "/" + match.group(2)
                    req = urllib.request.Request(api_url, headers={"User-Agent": "TTC-Recruitment/1", "Accept": "application/vnd.github+json"})
                    with opener.open(req, timeout=5) as response:
                        payload = json.loads(response.read(20_000).decode("utf-8", "replace"))
                    result["source"] = "github_public_repo"
                    result["verificationStatus"] = "public_project_found"
                    result["details"] = ("公开仓库可访问：" + str(payload.get("full_name", ""))[:100]
                                         + "；不代表候选人身份或个人贡献已核实。")
                else:
                    result["details"] = "GitHub 链接不是仓库地址，未核验具体项目。"
            else:
                req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "TTC-Recruitment/1"})
                with opener.open(req, timeout=5) as response:
                    status = response.status
                if status == 200:
                    result["verificationStatus"] = "reachable"
                    result["details"] = "链接可访问；页面内容、作者身份和简历声明未核实。"
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError):
            result["verificationStatus"] = "unreachable"
            result["details"] = "核验时未能访问链接；不等同于简历声明有误。"
        items.append(result)
    return items
