#!/usr/bin/env bash
# 一键部署：woaiyrb.com
#
# 在服务器上以 root 执行：
#     curl -fsSL https://raw.githubusercontent.com/Lxc097/TTC/main/deploy/setup.sh | bash
# 或者先把仓库拉到服务器，再 bash deploy/setup.sh
#
# 幂等：可以重复执行，不会重复建库/重复配 nginx。
set -euo pipefail

DOMAIN="woaiyrb.com"
WWW="www.woaiyrb.com"
APP_DIR="/opt/ttc"
REPO="https://github.com/Lxc097/TTC.git"
SERVICE="ttc-backend"
EMAIL="${CERTBOT_EMAIL:-}"      # 证书到期提醒邮箱；不填就跳过自动签证书

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行（sudo -i 之后再跑）"

# ---------------------------------------------------------------- 1. 依赖
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip nginx git curl ca-certificates

# ---------------------------------------------------------------- 2. 取代码
log "拉取代码到 $APP_DIR"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --quiet
  git -C "$APP_DIR" reset --hard origin/main --quiet
else
  # 目录非空时 git clone 会失败，先清掉
  [ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ] || rm -rf "$APP_DIR"/*
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
chmod +x "$APP_DIR"/deploy/*.sh || true

# ---------------------------------------------------------------- 3. Python 环境
log "建虚拟环境并装依赖"
cd "$APP_DIR"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r qiyeduan/backend/requirements.txt

# ---------------------------------------------------------------- 4. .env
log "准备 .env（不存在才创建，默认 mock，不花钱）"
ENV_FILE="$APP_DIR/qiyeduan/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENVEOF'
# 生产默认：mock 数据源，不开 LLM —— 公开链接谁都能点，默认不产生任何费用。
# 要开真实能力，把下面两项改成 facephys / 1，并填上 key（改完 systemctl restart ttc-backend）。
VISION_PROVIDER=mock
LLM_ENABLED=0

# FacePhys（真实心率需要它）
TTC_API_BASE=https://www.facephys.com
TTC_API_KEY_ID=
TTC_API_SECRET=

# LLM（语义分析 / 写追问）
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_API_KEY=

# 视频形态的调参
MIN_QUALITY=0.15
BASELINE_SECONDS=60
BASELINE_MIN_SAMPLES=2
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE（默认 mock/no-LLM）"
else
  echo "$ENV_FILE 已存在，保持不动"
fi

# ---------------------------------------------------------------- 5. systemd
log "配置 systemd 服务 $SERVICE"
cat > "/etc/systemd/system/$SERVICE.service" <<UNITEOF
[Unit]
Description=TTC backend (FastAPI/uvicorn)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/qiyeduan/backend
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONIOENCODING=utf-8
ExecStart=$APP_DIR/.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" || {
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "$SERVICE 启动失败"
}
curl -fsS --max-time 5 http://127.0.0.1:8000/healthz >/dev/null || die "后端 8000 不健康"

# ---------------------------------------------------------------- 6. nginx
log "配置 nginx"
cat > "/etc/nginx/sites-available/$DOMAIN" <<'NGINXEOF'
server {
    listen 80;
    listen [::]:80;
    server_name woaiyrb.com www.woaiyrb.com;

    root /opt/ttc/frontend;
    index index.html;

    # 前端是纯静态 SPA（hash 路由），找不到文件就回首页
    location / {
        try_files $uri $uri/ /index.html;
    }

    # REST 接口
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        client_max_body_size 32m;
    }

    # WebSocket：必须升级头 + 关掉读超时，否则长时间面试会被切断
    location /ws/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 32m;
    }

    # 自测台 / 录制器（FastAPI 提供的两个静态页）
    location = /healthz { proxy_pass http://127.0.0.1:8000; }
}
NGINXEOF

ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------- 7. 验证
log "验证 HTTP"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $DOMAIN" http://127.0.0.1/)
[ "$code" = "200" ] || die "首页返回 $code"
api=$(curl -s --max-time 8 -H "Host: $DOMAIN" http://127.0.0.1/api/config)
echo "  /api/config -> $api"

# ---------------------------------------------------------------- 8. HTTPS
if [ -n "$EMAIL" ]; then
  log "申请 Let's Encrypt 证书"
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" -d "$WWW" --non-interactive --agree-tos \
          -m "$EMAIL" --redirect || echo "证书申请失败，先用 http 访问"
else
  cat <<EOF

未设置 CERTBOT_EMAIL，跳过 HTTPS。要开 HTTPS 再执行：
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d $DOMAIN -d $WWW --agree-tos -m 你的邮箱 --redirect

EOF
fi

log "完成"
cat <<EOF
  http://$DOMAIN
  http://$WWW

  后端自测台 : http://$DOMAIN/api/../  (FastAPI 根路径未反代，直接用端口看)
  查看日志   : journalctl -u $SERVICE -f
  改配置后重启: systemctl restart $SERVICE
  .env 位置  : $ENV_FILE
EOF
