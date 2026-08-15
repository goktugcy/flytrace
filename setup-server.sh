#!/usr/bin/env bash
#
# FlyTrace — AWS Ubuntu kurulum + deploy scripti.
#
#   curl -fsSL -o setup-server.sh <bu-dosya>   # ya da scp ile at
#   chmod +x setup-server.sh
#   ./setup-server.sh
#
# Tekrar çalıştırılabilir: var olan .env.production'ı ve sertifikaları ASLA
# üzerine yazmaz. Bir adımda patlarsa düzeltip yeniden çalıştırabilirsin.
#
# Ubuntu 22.04 / 24.04, `ubuntu` kullanıcısı ile test edilmek üzere yazıldı.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/goktugcy/flytrace.git}"
APP_DIR="${APP_DIR:-/srv/flytrace}"
ENV_FILE="$APP_DIR/.env.production"
COMPOSE_FILE="$APP_DIR/docker-compose.production.yml"
CERT_DIR="$APP_DIR/deploy/nginx/certs"

# ── çıktı ────────────────────────────────────────────────────────────────────
bold=$(tput bold 2>/dev/null || echo ''); dim=$(tput dim 2>/dev/null || echo '')
red=$(tput setaf 1 2>/dev/null || echo ''); grn=$(tput setaf 2 2>/dev/null || echo '')
ylw=$(tput setaf 3 2>/dev/null || echo ''); rst=$(tput sgr0 2>/dev/null || echo '')

step()  { echo; echo "${bold}══ $* ${rst}"; }
ok()    { echo "  ${grn}✓${rst} $*"; }
warn()  { echo "  ${ylw}!${rst} $*"; }
die()   { echo "  ${red}✗ $*${rst}" >&2; exit 1; }
ask()   { local p="$1" d="${2:-}" v; read -rp "  ${p}${d:+ [$d]}: " v; echo "${v:-$d}"; }

# `sudo su` ya da minimal bir kabukta $USER boş gelebilir; her yerde bunu kullan.
RUN_USER="${USER:-$(id -un)}"

# docker'ı sudo'suz kullanabiliyor muyuz? (gruba yeni eklendiysek bu kabuk henüz bilmiyor)
DOCKER_SUDO=""
docker_ready() { $DOCKER_SUDO docker info >/dev/null 2>&1; }
dc() { $DOCKER_SUDO docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# ── 0. ön kontroller ─────────────────────────────────────────────────────────
step "0/9  Ön kontroller"

# Ayrıcalık nasıl alınacak? Üç geçerli durum var ve script hepsinde çalışmalı:
# root olarak çalışmak (tarayıcı konsolu, `sudo su`), parolasız sudo (bulut
# imajlarının varsayılanı), parolalı sudo. Hiçbiri yoksa paket kuramaz,
# swap açamaz, firewall'a dokunamaz — o zaman baştan söylemek gerekir.
SUDO=""
if [[ $EUID -eq 0 ]]; then
  ok "root olarak çalışıyor — sudo gerekmiyor"
elif ! command -v sudo >/dev/null; then
  die "Ne root'sun ne de sudo kurulu. Kurulum root ayrıcalığı olmadan yapılamaz."
elif sudo -n true 2>/dev/null; then
  SUDO="sudo"
  ok "sudo kullanılabilir (parola sormuyor)"
else
  warn "sudo parola soracak. Bu kullanıcının parolası yoksa Ctrl-C ile çık ve"
  warn "sunucuya root olarak girip scripti öyle çalıştır."
  sudo -v || die "sudo yetkisi alınamadı. root olarak çalıştırmayı dene."
  SUDO="sudo"
  ok "sudo doğrulandı"
fi

. /etc/os-release 2>/dev/null || die "/etc/os-release okunamadı — Ubuntu değil mi?"
[[ "${ID:-}" == "ubuntu" ]] || warn "Ubuntu değil (${ID:-bilinmiyor}) — devam ediliyor ama test edilmedi."
ok "OS: ${PRETTY_NAME:-?}"

TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
ok "RAM: ${TOTAL_MB} MB"
if (( TOTAL_MB < 7500 )); then
  warn "compose bellek limitlerinin toplamı ~7.8 GB. Bu makinede OOM killer devreye girebilir."
  warn "Kurulumdan sonra docker-compose.production.yml içindeki *_MEMORY_LIMIT değerlerini düşür."
fi

DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
ok "Boş disk: ${DISK_GB} GB"
(( DISK_GB >= 25 )) || die "En az 25 GB boş alan gerekiyor (imajlar + Postgres). Şu an ${DISK_GB} GB."

# ── 1. paketler ──────────────────────────────────────────────────────────────
step "1/9  Sistem paketleri"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq git curl ca-certificates openssl ufw >/dev/null
ok "git, curl, openssl, ufw kurulu"

# ── 2. swap ──────────────────────────────────────────────────────────────────
step "2/9  Swap"
# AWS imajlarında genelde swap yoktur; web (Next.js) derlemesi belleği zorlar.
if (( $(free -m | awk '/^Swap:/{print $2}') > 0 )); then
  ok "Swap zaten var ($(free -h | awk '/^Swap:/{print $2}'))"
elif [[ -f /swapfile ]]; then
  ok "/swapfile mevcut"
else
  $SUDO fallocate -l 4G /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap -q /swapfile
  $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  ok "4 GB swap açıldı ve /etc/fstab'a eklendi"
fi

# ── 3. docker ────────────────────────────────────────────────────────────────
step "3/9  Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  ok "Docker + compose zaten kurulu"
else
  curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
  ok "Docker kuruldu"
fi

if ! groups "$RUN_USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$RUN_USER"
  warn "Kullanıcı 'docker' grubuna eklendi ama bu kabuk henüz bilmiyor."
  warn "Bu çalıştırmada docker komutları sudo ile gidecek. Script bitince bir kez çıkıp gir."
fi
docker_ready || DOCKER_SUDO="$SUDO"
docker_ready || die "Docker daemon'a erişilemiyor."
ok "Docker çalışıyor ($($DOCKER_SUDO docker --version))"

# ── 4. kod ───────────────────────────────────────────────────────────────────
step "4/9  Kod"
if [[ -d "$APP_DIR/.git" ]]; then
  ok "Depo zaten var: $APP_DIR"
else
  $SUDO mkdir -p "$APP_DIR"
  $SUDO chown "$RUN_USER:$RUN_USER" "$APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
  ok "Klonlandı: $REPO_URL"
fi
cd "$APP_DIR"
[[ -f "$COMPOSE_FILE" ]] || die "$COMPOSE_FILE yok — depo beklenenden farklı."

# ── 5. env ───────────────────────────────────────────────────────────────────
step "5/9  Ortam değişkenleri"
# İki host'un etiket sınırındaki en uzun ortak son eki.
#   flytrace.live + api.flytrace.live -> flytrace.live
# Naif `${host#*.}` yalnızca web bir alt alan adıysa doğru sonuç verir; apex
# kullanıldığında `.live` üretir ve o bir public suffix olduğu için tarayıcı
# çerezi tümden reddeder — giriş sessizce çalışmaz.
common_domain() {
  local -a a b; local out="" i j
  IFS='.' read -ra a <<< "$1"
  IFS='.' read -ra b <<< "$2"
  i=$(( ${#a[@]} - 1 )); j=$(( ${#b[@]} - 1 ))
  while (( i >= 0 && j >= 0 )) && [[ "${a[i]}" == "${b[j]}" ]]; do
    out="${a[i]}${out:+.}${out}"; ((i--)); ((j--))
  done
  echo "$out"
}

# Var olan bir env dosyasına asla dokunma — ama "var" demek "kullanılabilir"
# demek değil. Boş ya da eksik bir dosyayı sessizce kabul edersek adım 8'de
# compose yirmi satır "missing value" basar ve sebebi burada olduğu anlaşılmaz.
env_usable() {
  [[ -s "$ENV_FILE" ]] || return 1
  local key
  for key in DATABASE_URL REDIS_URL AUTH_SECRET INTERNAL_API_TOKEN POSTGRES_PASSWORD; do
    grep -qE "^${key}=.+" "$ENV_FILE" || return 1
  done
}

if [[ -f "$ENV_FILE" ]] && env_usable; then
  ok ".env.production zaten var ve dolu — dokunulmuyor"
  warn "Yeniden üretmek istersen önce onu taşı: mv $ENV_FILE $ENV_FILE.bak"
elif [[ -f "$ENV_FILE" ]]; then
  warn "$ENV_FILE var ama boş ya da eksik — yeniden oluşturuluyor."
  mv "$ENV_FILE" "${ENV_FILE}.bozuk.$(date +%s)"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "  ${dim}Alan adlarını Cloudflare'de bu sunucuya yönlendirmiş olman gerekiyor.${rst}"
  APP_HOST=$(ask "Web alan adı" "app.example.com")
  API_HOST=$(ask "API alan adı" "api.example.com")

  ROOT_DOMAIN=$(common_domain "$APP_HOST" "$API_HOST")
  if [[ "$ROOT_DOMAIN" != *.* ]]; then
    warn "'$APP_HOST' ile '$API_HOST' ortak bir alan adı paylaşmıyor."
    warn "Çerezler paylaşılamaz; SESSION_COOKIE_DOMAIN boş bırakılıyor."
    ROOT_DOMAIN=""
    COOKIE_DEFAULT=""
  else
    COOKIE_DEFAULT=".${ROOT_DOMAIN}"
  fi

  COOKIE_DOMAIN=$(ask "Çerez domaini (boş = paylaşma)" "$COOKIE_DEFAULT")
  EMAIL_KEY=$(ask "EMAIL_API_KEY (Resend/Brevo) — boş bırakırsan API AÇILMAZ")
  EMAIL_FROM=$(ask "Gönderen adres" "FlyTrace <alerts@${ROOT_DOMAIN:-example.com}>")

  [[ -n "$EMAIL_KEY" ]] || warn "EMAIL_API_KEY boş. Şifre sıfırlama ve güvenlik uyarıları teslim edilemeyeceği için API boot etmeyecek."

  gen() { openssl rand -hex 32; }
  PG_PW=$(gen); REDIS_PW=$(gen)

  # Önce geçici dosyaya yaz, hepsi bittikten sonra yerine koy. Yarım kalmış bir
  # .env.production bırakmak en kötü sonuç olurdu: script tekrar çalıştığında
  # "zaten var" deyip atlar ve doldurulmamış dosyayla deploy edilir.
  TMP_ENV=$(mktemp)
  trap 'rm -f "$TMP_ENV"' EXIT
  cp deploy/env/production.env.example "$TMP_ENV"

  # Değerleri tek python çağrısında uygula. encoding AÇIKÇA utf-8: sunucunun
  # locale'i C ise python dosyayı ASCII sanıp şablondaki '—' gibi karakterleri
  # surrogate'e çevirir ve geri yazarken UnicodeEncodeError verir.
  python3 - "$TMP_ENV" <<PY
import sys
path = sys.argv[1]
values = {
    "POSTGRES_PASSWORD":         """${PG_PW}""",
    "REDIS_PASSWORD":            """${REDIS_PW}""",
    "DATABASE_URL":              """postgres://flytrace:${PG_PW}@postgres:5432/flytrace""",
    "REDIS_URL":                 """redis://:${REDIS_PW}@redis:6379""",
    "AUTH_SECRET":               """$(gen)""",
    "MFA_SECRET_ENCRYPTION_KEY": """$(gen)""",
    "INTERNAL_API_TOKEN":        """$(gen)""",
    "TELEGRAM_WEBHOOK_SECRET":   """$(gen)""",
    "AUTH_URL":                  """https://${API_HOST}""",
    "CORS_ORIGINS":              """https://${APP_HOST}""",
    "WEB_BASE_URL":              """https://${APP_HOST}""",
    "NEXT_PUBLIC_API_URL":       """https://${API_HOST}""",
    "NEXT_PUBLIC_WS_URL":        """wss://${API_HOST}/ws""",
    "SESSION_COOKIE_DOMAIN":     """${COOKIE_DOMAIN}""",
    "EMAIL_API_KEY":             """${EMAIL_KEY}""",
    "EMAIL_FROM":                """${EMAIL_FROM}""",
}
with open(path, encoding="utf-8") as f:
    lines = f.read().split("\n")
seen = set()
for i, line in enumerate(lines):
    for key, val in values.items():
        if line.startswith(key + "="):
            lines[i] = f"{key}={val}"
            seen.add(key)
            break
for key in values:
    if key not in seen:
        lines.append(f"{key}={values[key]}")
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
PY

  chmod 600 "$TMP_ENV"
  mv "$TMP_ENV" "$ENV_FILE"
  trap - EXIT
  ok ".env.production oluşturuldu (chmod 600), secret'lar üretildi"
  [[ -n "$COOKIE_DOMAIN" ]] && ok "Çerez domaini: $COOKIE_DOMAIN"
fi

# ── 6. TLS ───────────────────────────────────────────────────────────────────
step "6/9  TLS sertifikası"
mkdir -p "$CERT_DIR"
if [[ -s "$CERT_DIR/fullchain.pem" && -s "$CERT_DIR/privkey.pem" ]]; then
  ok "Sertifika zaten yerinde"
else
  cat <<EOF

  ${bold}Cloudflare Origin Certificate gerekiyor.${rst}
  Panel → SSL/TLS → Origin Server → Create Certificate → varsayılanlarla oluştur.
  İki kutu verecek. Aşağıya sırayla yapıştır.
  ${dim}(Let's Encrypt kullanılmıyor: nginx'te ACME bloğu var ama compose'da
  certbot servisi ve webroot volume'ü yok, o yol olduğu gibi çalışmıyor.)${rst}

EOF
  echo "  ${bold}1) Origin Certificate${rst} — yapıştır, sonra Ctrl-D:"
  cat > "$CERT_DIR/fullchain.pem"
  echo "  ${bold}2) Private Key${rst} — yapıştır, sonra Ctrl-D:"
  cat > "$CERT_DIR/privkey.pem"
  chmod 644 "$CERT_DIR/fullchain.pem"; chmod 600 "$CERT_DIR/privkey.pem"
fi

openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject >/dev/null 2>&1 \
  || die "fullchain.pem geçerli bir sertifika değil."
openssl pkey -in "$CERT_DIR/privkey.pem" -noout >/dev/null 2>&1 \
  || die "privkey.pem geçerli bir anahtar değil."
# Sertifika ve anahtar eşleşiyor mu — eşleşmezse nginx sessizce açılmaz.
c=$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -pubkey | openssl md5)
k=$(openssl pkey -in "$CERT_DIR/privkey.pem" -pubout | openssl md5)
[[ "$c" == "$k" ]] || die "Sertifika ile anahtar eşleşmiyor — yanlış kutuları yapıştırmış olabilirsin."
ok "Sertifika geçerli ve anahtarla eşleşiyor"
ok "$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate)"

echo
warn "Cloudflare panelinde SSL/TLS → Overview → ${bold}Full (strict)${rst}${ylw} seçili olmalı."
warn "'Flexible' seçiliyse CF ile sunucu arası düz HTTP olur; oturum çerezleri açıktan gider."

# ── 7. güvenlik duvarı ───────────────────────────────────────────────────────
step "7/9  Güvenlik duvarı"
cat <<EOF
  ${dim}nginx gerçek istemci IP'sini CF-Connecting-IP başlığından okuyor. Bu ancak
  sunucuya Cloudflare dışından ulaşılamıyorsa bir şey ifade eder — aksi halde
  origin IP'sini bulan biri rate-limit kovasını kendi seçer.${rst}

  ${bold}AWS EC2'daysan${rst} aynı kısıtı Security Group ile de yapabilirsin.
  ${bold}Lightsail'deysen${rst} konsoldaki IPv4 Firewall her CIDR'ı tek tek
  istediği için pratik değil — 80/443'ü orada açık bırak, kısıtlamayı ufw yapsın.
EOF
if [[ "$(ask 'ufw ile 80/443 sadece Cloudflare aralıklarına açılsın mı? (e/h)' 'e')" == "e" ]]; then
  $SUDO ufw --force reset >/dev/null
  $SUDO ufw default deny incoming >/dev/null
  $SUDO ufw default allow outgoing >/dev/null
  $SUDO ufw allow OpenSSH >/dev/null
  n=0
  for ip in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
    $SUDO ufw allow from "$ip" to any port 80,443 proto tcp >/dev/null
    n=$((n+1))
  done
  $SUDO ufw --force enable >/dev/null
  ok "ufw etkin — SSH açık, 80/443 yalnızca ${n} Cloudflare aralığına açık"
  warn "SSH'ı kaybetmediğini DOĞRULA: yeni bir terminalden bağlanmayı dene."
else
  warn "ufw atlandı. Security Group'ta 80/443'ü Cloudflare aralıklarıyla sınırla."
fi

# ── 8. derle ve kaldır ───────────────────────────────────────────────────────
step "8/9  İmajları derle ve servisleri başlat"
echo "  ${dim}İlk derleme 5–15 dakika sürebilir.${rst}"
$DOCKER_SUDO docker buildx bake -f deploy/docker-bake.hcl
ok "İmajlar derlendi"

dc up -d
ok "Servisler başlatıldı"

echo "  Migration job'ı bekleniyor…"
for i in $(seq 1 60); do
  code=$($DOCKER_SUDO docker inspect -f '{{.State.ExitCode}}' "$(dc ps -aq migrate 2>/dev/null | head -1)" 2>/dev/null || echo "")
  [[ "$code" == "0" ]] && { ok "Migration tamam (exit 0)"; break; }
  [[ -n "$code" && "$code" != "0" ]] && { dc logs migrate | tail -20; die "Migration başarısız (exit $code)."; }
  sleep 5
done

if [[ "$(ask 'Katalog verisi yüklensin mi? (havayolları/havaalanları, birkaç dakika) (e/h)' 'e')" == "e" ]]; then
  dc run --rm migrate bun run src/seed.ts && ok "Seed tamam"
fi

# ── 9. duman testi ───────────────────────────────────────────────────────────
step "9/9  Doğrulama"
dc ps

TOKEN=$(grep '^INTERNAL_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
API_HOST_V=$(grep '^AUTH_URL=' "$ENV_FILE" | cut -d= -f2- | sed 's#https://##')

echo
echo "  ${bold}Konteyner içinden (DNS/Cloudflare'den bağımsız):${rst}"
probe() {
  local path="$1" want="$2" hdr="${3:-}"
  local code
  code=$(dc exec -T proxy sh -c \
    "wget -qO- -S --header='Host: ${API_HOST_V}' ${hdr:+--header='$hdr'} https://127.0.0.1${path} --no-check-certificate 2>&1 \
     | awk '/HTTP\\//{print \$2; exit}'" 2>/dev/null || echo "-")
  if [[ "$code" == "$want" ]]; then ok "${path} → ${code}"; else warn "${path} → ${code} (beklenen ${want})"; fi
}
probe /health 200
probe /health/ready 200
probe /metrics 404
probe /metrics 200 "Authorization: Bearer ${TOKEN}"

cat <<EOF

${bold}══ Bitti ${rst}

  Dışarıdan dene:
    curl https://${API_HOST_V}/health
    https://$(grep '^WEB_BASE_URL=' "$ENV_FILE" | cut -d= -f2- | sed 's#https://##')

  Gerçek istemci IP'si geçiyor mu (rate limit'in doğru çalışması buna bağlı):
    cd ${APP_DIR} && docker compose -f docker-compose.production.yml --env-file .env.production logs proxy | tail -5
  ${dim}Log'daki adres senin çıkış IP'n olmalı, bir Cloudflare IP'si değil.${rst}

  Telegram kullanacaksan:
    ${dim}.env.production içine TELEGRAM_BOT_TOKEN ve TELEGRAM_BOT_USERNAME ekle
    (TELEGRAM_WEBHOOK_SECRET zaten üretildi), sonra:${rst}
    cd ${APP_DIR} && docker compose -f docker-compose.production.yml --env-file .env.production \\
      exec api bun run scripts/telegram-webhook.ts set https://${API_HOST_V}

  Güncelleme:
    cd ${APP_DIR} && git pull && docker buildx bake -f deploy/docker-bake.hcl \\
      && docker compose -f docker-compose.production.yml --env-file .env.production up -d

  ${red}docker system prune -a --volumes ÇALIŞTIRMA${rst} — volume'leri siler, veritabanın gider.

EOF
