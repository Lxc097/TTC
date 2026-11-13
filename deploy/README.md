# 部署 · woaiyrb.com

目标：把仓库里的网站跑到 `47.77.199.66`（Ubuntu，硅谷），用 `woaiyrb.com` 访问。

## 现状（已确认）

| 项 | 状态 |
|---|---|
| DNS A 记录 `woaiyrb.com` / `www` → `47.77.199.66` | ✅ 已生效 |
| 服务器 22 端口 | ✅ 可连 |
| Ubuntu + python3 | ✅（部署脚本会装 venv/nginx） |
| SSH 密钥登录 | ❌ **当前未授权**（`Permission denied (publickey)`） |

## 方式一：授权我的公钥，我全程远程部署

在云控制台的「远程连接 / Web 终端」里执行：

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEzd2uhvybJwGjRU9dxJ4nk54ehZmrQQUHJG54bBoaVM rog@LAPTOP-ARA24944' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

执行完告诉我用的是 `root` 还是 `ubuntu`，我直接接管。

## 方式二：你自己跑一条命令

以 **root** 登录服务器后：

```bash
curl -fsSL https://raw.githubusercontent.com/Lxc097/TTC/main/deploy/setup.sh | bash
```

带 HTTPS（推荐，WebSocket 在 https 页面里必须用 wss）：

```bash
curl -fsSL https://raw.githubusercontent.com/Lxc097/TTC/main/deploy/setup.sh | CERTBOT_EMAIL=你的邮箱 bash
```

## 方式三：手动分步

```bash
sudo -i
apt-get update && apt-get install -y python3-venv python3-pip nginx git
git clone --depth 1 https://github.com/Lxc097/TTC.git /opt/ttc
cd /opt/ttc && python3 -m venv .venv && .venv/bin/pip install -r qiyeduan/backend/requirements.txt
# 然后照 deploy/setup.sh 里第 4~6 步建 .env / systemd / nginx
```

## 部署后是什么状态

- nginx 在 80/443 提供 `frontend/` 静态页
- `/api/` 和 `/ws/` 反代到本机 `127.0.0.1:8000`（uvicorn，由 `ttc-backend.service` 托管）
- **默认 `VISION_PROVIDER=mock` + `LLM_ENABLED=0`**：公开链接谁都能点，默认不产生任何费用
- `.env` 权限 600，不在 git 里

要开真实能力：

```bash
vi /opt/ttc/qiyeduan/backend/.env     # 改 VISION_PROVIDER=facephys、LLM_ENABLED=1、填 key
systemctl restart ttc-backend
```

## 运维命令

```bash
systemctl status ttc-backend
journalctl -u ttc-backend -f          # 实时日志
systemctl restart ttc-backend         # 改完 .env 或代码后
git -C /opt/ttc pull && systemctl restart ttc-backend
nginx -t && systemctl reload nginx
```

## 已知限制

1. **服务器在硅谷，演示在国内。** 20 秒视频块 base64 后约 4MB，跨境上传可能 10~30 秒，
   比本地慢很多。**正式比赛演示仍建议跑本机**，服务器上的公开链接用于"发给评委自己试"。
2. **公开可访问**：任何人拿到链接都能创建房间。房间号随机 6 位、会话在内存里、重启即清空。
   真要对外挂，建议在 nginx 的 `server` 块里加一层 Basic Auth：
   ```nginx
   auth_basic "TTC";
   auth_basic_user_file /etc/nginx/.htpasswd;   # htpasswd -c /etc/nginx/.htpasswd demo
   ```
3. **后端重启会清空所有会话**（内存存储，这是刻意的"面试结束即删除"设计）。
4. `uvicorn --reload` 只在本地用；服务器上用 systemd 托管，改代码后 `systemctl restart`。
