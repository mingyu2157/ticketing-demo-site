# 카카오클라우드 Kubernetes 배포 가이드 v3.0 (실행용)

> 문서: 20260808_k8s_deployment_guide_v3.0
> 대상 서비스: VLUR — 아스키 아트 기반 AI CAPTCHA (vlur.site) + 티켓팅 데모 (ticket.vlur.site)
> 배포 대상: 카카오클라우드 Kubernetes Engine · 운영 방식: 상시 가동(24/7)
> 선행 문서: `20260612_k8s_deployment_guide_v2.0.md` (개념 설명) — 이 문서는 **현재 저장소 상태에 맞춘 실제 실행 절차**입니다.

---

## 0. 이 문서로 배포되는 것

### 0-1. 아키텍처

```
사용자 ──▶ L7 LB ──▶ Ingress(nginx) ──┬─ vlur.site        ─▶ frontend(nginx) ──┬─ /api, /static ─▶ backend ──┬─▶ mysql (StatefulSet + 블록스토리지 40Gi)
                    (TLS: cert-manager)│                                        └─ 그 외 정적 파일             └─▶ ai (드래그 봇판별 CNN, CPU 추론)
                                       └─ ticket.vlur.site ─▶ ticketing-demo(nginx, 정적)
```

- **경로 라우팅은 Ingress가 아니라 frontend nginx가 담당**합니다. `/api/v1/captcha/*`는 prefix를 유지한 채, 나머지 `/api/*`는 prefix를 떼고 백엔드로 넘기는 재작성 규칙([nginx/default.conf.template](../nginx/default.conf.template))이 이미 이미지 안에 있기 때문에, Ingress는 도메인 단위로만 나눕니다.
- **AI 추론은 클러스터 안 파드**로 배포합니다(모델 ~5MB, CPU torch). 클러스터 밖 GPU-01로 전환하는 방법은 Phase 10에 별도로 있습니다.
- 챌린지 상태는 DB(captchas 테이블)에 저장되므로 backend를 2 replica로 띄워도 검증이 깨지지 않습니다.

### 0-2. 배포 산출물 (이 저장소 `k8s/manifests/`)

| 파일 | 내용 |
|---|---|
| `00-namespace.yaml` | `captcha` 네임스페이스 |
| `05-app-config.yaml` | 비민감 설정 ConfigMap (DB_HOST=mysql, AI_SERVICE_URL 등) |
| `10-mysql.yaml` | MySQL StatefulSet + 헤드리스 Service + PVC 40Gi (이미지: vlur-database — 초기화 SQL 내장) |
| `20-ai.yaml` | AI 추론 Deployment(×2) + Service |
| `30-backend.yaml` | FastAPI Deployment(×2) + Service |
| `40-frontend.yaml` | nginx 정적서빙+프록시 Deployment(×2) + Service |
| `50-ticketing-demo.yaml` | 티켓팅 데모 Deployment(×1) + Service |
| `60-ingress.yaml` | vlur.site / ticket.vlur.site 라우팅 + TLS |
| `65-cluster-issuer.yaml` | Let's Encrypt ClusterIssuer (cert-manager) |
| `70-db-backup.yaml` | 매일 03:00 KST mysqldump CronJob + 백업 PVC 10Gi |

### 0-3. 치환해야 하는 값 (placeholder)

매니페스트 안의 아래 토큰을 **apply 전에 반드시 실제 값으로 치환**합니다. 치환 명령은 Phase 5에 있습니다.

| 토큰 | 들어갈 값 | 확인 방법 |
|---|---|---|
| `__GIT_SHA__` | CI가 이미지를 빌드한 AI-Captcha 커밋 전체 SHA | GitHub Actions 실행 로그 또는 `git rev-parse upstream/develop` |
| `__DEMO_GIT_SHA__` | ticketing-demo-site 이미지의 커밋 SHA | 해당 저장소 Actions (Phase 2-3에서 만듦) |
| `__STORAGE_CLASS__` | 블록 스토리지 StorageClass 이름 | `kubectl get sc` |
| `__ACME_EMAIL__` | 인증서 만료 알림 받을 이메일 | — |

### 0-4. 미리 준비할 것 (체크리스트)

- [ ] 클러스터 kubeconfig (카카오클라우드 콘솔에서 발급)
- [ ] `kubectl` 설치 (macOS: `brew install kubectl`)
- [ ] Container Registry 자격증명 — 액세스 키 ID / 시크릿 액세스 키 (CI Secrets에 쓰는 `KCR_ACCESS_KEY_ID` / `KCR_SECRET_ACCESS_KEY`와 동일한 것)
- [ ] `vlur.site` 도메인의 DNS 관리 권한 (A 레코드 추가)
- [ ] GitHub `kakao-NoBot` 조직 저장소 관리 권한 (Actions Secrets 확인, 데모 저장소 워크플로우 추가)
- [ ] 팀 최신 `.env` (리다이렉트 URI가 `https://vlur.site` 기준인지 — Phase 5에서 형식만 정리해 사용)

---

## Phase 1. 클러스터 접속 확인

**[작업]** 콘솔에서 받은 kubeconfig로 접속을 설정합니다.

```bash
export KUBECONFIG=~/Downloads/kubeconfig-team2-cluster-prod.yaml   # 실제 경로로
# 매번 export가 번거로우면: KUBECONFIG를 ~/.kube/config 에 병합하거나 셸 rc에 추가
```

**[확인]**

```bash
kubectl get nodes        # 워커 노드 3대 STATUS=Ready
kubectl cluster-info     # 컨트롤 플레인 응답
```

> 안 되면: kubeconfig 경로 오타 / 토큰 만료 / VPN·허용 IP 여부부터 점검.

---

## Phase 2. 이미지 빌드 & 레지스트리 push (GitHub Actions)

이 저장소에는 CI가 **이미 구성되어 있습니다** — 새로 만들 것은 티켓팅 데모 쪽 하나뿐입니다.

| 워크플로우 | 트리거 | 산출 이미지 (`kc-sfacspace05.kr-central-2.kcr.dev/team2-repo/…`) |
|---|---|---|
| `backend-ai-images.yml` | develop push (backend/frontend/AI 변경) | `vlur-backend:sha-<커밋>`, `vlur-ai:sha-<커밋>` |
| `frontend-image.yml` | develop push (frontend/nginx 변경) | `vlur-frontend:sha-<커밋>` |
| `database-image.yml` | develop push (database 변경) | `vlur-database:sha-<커밋>` |

### 2-1. CI Secrets 확인

**[작업]** `kakao-NoBot/AI-Captcha` → Settings → Secrets and variables → Actions 에 `KCR_ACCESS_KEY_ID`, `KCR_SECRET_ACCESS_KEY` 가 등록되어 있는지 확인합니다. (CI가 최근에 성공한 적이 있으면 이미 등록된 것입니다.)

### 2-2. 4개 이미지 빌드 실행

**[작업]** 최신 develop 기준으로 이미지가 없다면, 각 워크플로우를 Actions 탭에서 **Run workflow(workflow_dispatch)** 로 수동 실행하거나, develop에 push가 일어나게 합니다. 세 워크플로우 모두 실행되어야 4개 이미지가 전부 만들어집니다.

**[확인]** Actions 실행이 초록색인지 보고, **빌드된 커밋의 전체 SHA를 메모**합니다(태그가 `sha-<전체SHA>`). 로컬에서 확인하려면:

```bash
git fetch upstream && git rev-parse upstream/develop
```

> 주의: 세 워크플로우가 서로 다른 커밋에서 돌았다면 이미지 태그도 제각각입니다. 헷갈리지 않게 **한 커밋에서 세 개를 모두 수동 실행**하는 걸 권장합니다.

### 2-3. 티켓팅 데모 이미지 CI 추가

`kakao-NoBot/ticketing-demo-site` 저장소에는 CI가 없으므로 추가합니다.

**[작업]** 데모 저장소의 develop 브랜치에 `.github/workflows/demo-image.yml` 로 아래 내용을 커밋합니다. 그리고 그 저장소 Settings에도 같은 `KCR_ACCESS_KEY_ID` / `KCR_SECRET_ACCESS_KEY` Secrets를 등록합니다(조직 수준 Secret이면 생략).

```yaml
name: Ticketing Demo Image Build

on:
  workflow_dispatch:
  push:
    branches: [develop]

permissions:
  contents: read

env:
  REGISTRY: kc-sfacspace05.kr-central-2.kcr.dev
  IMAGE_NAME: team2-repo/vlur-ticketing-demo

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ secrets.KCR_ACCESS_KEY_ID }}
          password: ${{ secrets.KCR_SECRET_ACCESS_KEY }}
      - uses: docker/build-push-action@v7
        with:
          context: .
          platforms: linux/amd64
          push: true
          build-args: |
            VLUR_API_BASE=https://vlur.site
            VLUR_PUBLIC_SITE_KEY=pk-aicap_dev_testuser_001
            VLUR_WIDGET_URL=https://vlur.site/static/widget/vlur-captcha.js
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}
```

> `VLUR_PUBLIC_SITE_KEY`는 일단 시드 데이터의 dev 키로 두고, 배포 완료 후 **실제 발급 키로 교체해 재빌드**합니다(Phase 8-4). 데모가 캡차를 띄우려면 그 Site Key에 등록된 도메인이 `ticket.vlur.site`와 일치해야 Origin 검증을 통과합니다.

**[확인]** Actions 성공 후 커밋 SHA 메모 (`__DEMO_GIT_SHA__`에 사용).

---

## Phase 3. 클러스터 기반 3종 — imagePullSecret · CSI · Ingress Controller(+cert-manager)

### 3-1. 레지스트리 pull 자격증명 (regcred)

**[작업]** 네임스페이스를 먼저 만들고, pull용 Secret을 생성합니다.

```bash
kubectl apply -f k8s/manifests/00-namespace.yaml

kubectl -n captcha create secret docker-registry regcred \
  --docker-server=kc-sfacspace05.kr-central-2.kcr.dev \
  --docker-username='<KCR_ACCESS_KEY_ID>' \
  --docker-password='<KCR_SECRET_ACCESS_KEY>'
```

모든 Deployment/StatefulSet에는 `imagePullSecrets: regcred`가 이미 들어 있습니다.

**[확인]**

```bash
kubectl -n captcha run pulltest --restart=Never \
  --image=kc-sfacspace05.kr-central-2.kcr.dev/team2-repo/vlur-frontend:sha-<메모한SHA> \
  --overrides='{"spec":{"imagePullSecrets":[{"name":"regcred"}]}}'
kubectl -n captcha get pod pulltest          # Running이면 pull 성공
kubectl -n captcha delete pod pulltest
```

> `ImagePullBackOff`면: 서버 주소/키 오타, 태그 오타(전체 SHA인지), 레지스트리 권한 순으로 확인.

### 3-2. CSI / StorageClass

**[작업+확인]**

```bash
kubectl get sc                               # 블록 스토리지 StorageClass 이름 메모 → __STORAGE_CLASS__
kubectl get pods -n kube-system | grep -i csi   # provisioner 파드 Running
```

- StorageClass가 없으면 카카오클라우드 콘솔의 CSI Provisioner 가이드대로 설치(클러스터당 1회, 권한 필요).
- `VOLUMEBINDINGMODE`가 `WaitForFirstConsumer`면 PVC가 파드 스케줄 전까지 `Pending`으로 보이는 게 **정상**입니다.

### 3-3. Ingress Controller

**[작업+확인]** 이미 있는지부터:

```bash
kubectl get pods,svc -A | grep -i ingress
```

- controller 파드가 Running이고 Service(type=LoadBalancer)에 `EXTERNAL-IP`가 있으면 → **그 IP를 메모**하고 다음으로.
- 없으면 설치:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx && helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --create-namespace
kubectl -n ingress-nginx get svc ingress-nginx-controller -w   # EXTERNAL-IP 뜰 때까지
```

> `<pending>`이 10분 이상 지속되면 LB 쿼터/권한 문제 → 운영진 문의.

### 3-4. cert-manager (TLS 자동 발급)

**[작업]**

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager get pods    # 3개 파드 Running까지 대기 (1~2분)
```

**[확인]** 3개 파드(cert-manager, cainjector, webhook) 모두 Running. ClusterIssuer apply는 Phase 5에서 합니다(placeholder 치환 후).

---

## Phase 4. DNS 연결

**[작업]** 도메인 관리 콘솔에서 A 레코드 2개를 Phase 3-3의 EXTERNAL-IP로 등록합니다.

| 레코드 | 타입 | 값 |
|---|---|---|
| `vlur.site` | A | `<EXTERNAL-IP>` |
| `ticket.vlur.site` | A | `<EXTERNAL-IP>` |

**[확인]**

```bash
dig +short vlur.site
dig +short ticket.vlur.site      # 둘 다 EXTERNAL-IP가 나오면 전파 완료
```

> 전파에 수 분~수 시간 걸릴 수 있습니다. **cert-manager의 인증서 발급(HTTP-01)은 DNS 전파가 끝나야 성공**하므로, 여기가 안 됐으면 Phase 8에서 인증서가 계속 Pending입니다. 미리 해두고 다음 단계를 진행하세요.

---

## Phase 5. 설정 주입 — .env 정비, Secret/ConfigMap, placeholder 치환

### 5-1. 프로덕션 .env 만들기

백엔드는 로컬 `.env` 전체를 Secret(`app-secret`)으로 받습니다. 현재 `.env`는 이미 리다이렉트 URI들이 `https://vlur.site` 기준으로 정리되어 있으므로 **값을 바꿀 일은 없고, 형식만 정리**하면 됩니다.

**[작업]**

```bash
# KEY=VALUE 형식이 아닌 줄(# 없이 쓴 섹션 제목)을 주석 처리하면서 복사한다.
# 이 정리를 건너뛰면 5-2의 secret 생성이 "is not a valid key name" 에러로 실패한다.
awk 'NF && $0 !~ /^[[:space:]]*#/ && $0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/ {print "# " $0; next} {print}' \
  .env > .env.k8s
```

**[확인]**

```bash
# 1) 형식이 깨진 줄이 남아 있는지 — 아무것도 출력되지 않아야 한다
awk 'NF && $0 !~ /^[[:space:]]*#/ && $0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/' .env.k8s

# 2) 실제로 secret이 만들어지는지 미리 검증 (클러스터 접속 없이 동작한다)
kubectl create secret generic app-secret --from-env-file=.env.k8s \
  --dry-run=client -o yaml > /dev/null && echo "형식 OK"

# 3) 도메인 값이 프로덕션 기준인지 눈으로 확인
grep -E "REDIRECT|FRONTEND_URL" .env.k8s
```

`VITE_VLUR_API_BASE` / `VITE_VLUR_SITE_KEY`는 Vite **빌드 시점**에 번들에 구워지는 값이라 백엔드 컨테이너에서는 아무 역할도 하지 않습니다. Secret에 남아 있어도 무해하니 그대로 두고, 실제 값은 CI의 `build-args`(Phase 2)에서 결정된다는 점만 기억하세요.

리다이렉트 URI는 **외부 콘솔에도 등록**되어 있어야 실제 로그인/결제가 됩니다. `.env` 값만 맞다고 되는 게 아니므로 아직 안 했다면 지금 확인하세요:

- Google Cloud Console → OAuth 클라이언트 → 승인된 리디렉션 URI에 `https://vlur.site/auth/google/callback` 추가
- Kakao Developers → 플랫폼/Redirect URI에 `https://vlur.site/auth/kakao/callback` 추가
- Naver Developers → 서비스 URL·Callback에 `https://vlur.site/auth/naver/callback` 추가
- 토스페이먼츠/카카오페이 개발자센터 → 성공·실패 리다이렉트 도메인에 `vlur.site` 등록

> `.env.k8s`는 커밋 금지(민감정보). `.gitignore`에 `.env*`가 있는지 확인하세요.
> JWT_SECRET_KEY, DB 비밀번호가 개발용 약한 값이면 **이 시점에 강한 값으로 교체**하는 것을 권장합니다(최초 배포 전이 가장 아픈 데 없이 바꿀 수 있는 시점입니다).
>
> `CORS_ALLOWED_ORIGINS`는 `.env`에 있지만 **현재 백엔드 코드가 읽지 않습니다** — `main.py`가 허용 오리진을 하드코딩하고 있고, 거기에 `https://vlur.site`와 `https://ticket.vlur.site`가 이미 들어 있어 배포에는 지장이 없습니다. 나중에 이 변수를 실제로 쓰도록 코드를 바꾼다면 두 가지를 고쳐야 합니다: 값에 `ticket.vlur.site`가 빠져 있고, 끝의 `/`를 떼야 합니다(브라우저가 보내는 `Origin` 헤더에는 슬래시가 없어서 문자열 비교가 어긋납니다).

### 5-2. Secret 두 개 생성

**[작업]**

```bash
# 1) 백엔드용 — .env.k8s 전체를 그대로
kubectl -n captcha create secret generic app-secret --from-env-file=.env.k8s

# 2) MySQL용 — .env.k8s의 DB_* 값을 MYSQL_* 이름으로 매핑
set -a; source .env.k8s; set +a
kubectl -n captcha create secret generic db-secret \
  --from-literal=MYSQL_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
  --from-literal=MYSQL_DATABASE="$DB_NAME" \
  --from-literal=MYSQL_USER="$DB_USER" \
  --from-literal=MYSQL_PASSWORD="$DB_PASSWORD"
```

> 백엔드의 DB 접속 정보(app-secret의 DB_USER/DB_PASSWORD)와 MySQL이 만드는 계정(db-secret의 MYSQL_USER/MYSQL_PASSWORD)이 **같은 원본에서 나오므로 반드시 일치**합니다 — 따로 타이핑하지 말고 위 명령을 그대로 쓰세요.

**[확인]**

```bash
kubectl -n captcha get secret app-secret db-secret
kubectl -n captcha get secret app-secret -o jsonpath='{.data.GOOGLE_REDIRECT_URI}' | base64 -d; echo
# → https://vlur.site/auth/google/callback 이 나와야 함
```

### 5-3. placeholder 치환 + ConfigMap/Issuer apply

**[작업]**

```bash
cd k8s/manifests

# macOS(BSD sed) 기준. Linux면 -i '' 대신 -i 만.
sed -i '' "s/__GIT_SHA__/<Phase2에서 메모한 AI-Captcha 커밋 전체 SHA>/g" *.yaml
sed -i '' "s/__DEMO_GIT_SHA__/<데모 저장소 커밋 전체 SHA>/g" 50-ticketing-demo.yaml
sed -i '' "s/__STORAGE_CLASS__/<Phase3-2의 StorageClass 이름>/g" *.yaml
sed -i '' "s/__ACME_EMAIL__/<본인 이메일>/g" 65-cluster-issuer.yaml

grep -rn "__" *.yaml    # 아무것도 안 나와야 함 (치환 누락 검사)

kubectl apply -f 05-app-config.yaml
kubectl apply -f 65-cluster-issuer.yaml
```

**[확인]**

```bash
kubectl -n captcha get configmap app-config -o yaml   # DB_HOST=mysql, AI_SERVICE_URL=http://ai:5000
kubectl get clusterissuer letsencrypt-prod            # READY=True (webhook 기동 직후엔 몇십 초 걸릴 수 있음)
```

---

## Phase 6. 데이터베이스 (StatefulSet + PVC)

**[작업]**

```bash
kubectl apply -f 10-mysql.yaml
```

**[확인]**

```bash
kubectl -n captcha get pvc                    # data-mysql-0 → Bound (WaitForFirstConsumer면 파드 뜨면서 Bound)
kubectl -n captcha get pods -w                # mysql-0 → Running (최초엔 초기화 SQL 때문에 1~3분)
kubectl -n captcha exec -it mysql-0 -- sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SHOW DATABASES; USE captcha; SHOW TABLES;"'
# captcha DB + plans/users/captchas 등 테이블이 보이면 초기화 성공
```

**알아둘 것**

- 초기화 SQL(vlur-database 이미지에 내장)은 **빈 볼륨에서 최초 1회만** 실행됩니다. 이후 스키마 변경은 백엔드가 시작할 때 `migrations.py`로 보정합니다.
- **PVC를 지우면 데이터가 전부 사라집니다.** "SQL을 다시 태우고 싶어서" PVC 삭제는 절대 금지. 스키마를 고치고 싶으면 migrations에 추가하는 게 맞는 경로입니다.
- 백업 CronJob도 미리 걸어둡니다: `kubectl apply -f 70-db-backup.yaml`

---

## Phase 7. AI + 백엔드

**[작업]** AI를 먼저(백엔드가 호출하는 쪽), 이어서 백엔드를 배포합니다.

```bash
kubectl apply -f 20-ai.yaml
kubectl -n captcha rollout status deploy/ai        # 완료까지 대기 (torch 로드로 수십 초)

kubectl apply -f 30-backend.yaml
kubectl -n captcha rollout status deploy/backend   # DB 마이그레이션 후 Ready (최대 수 분)
```

**[확인]**

```bash
kubectl -n captcha get pods                        # ai 2/2, backend 2/2 Running
kubectl -n captcha logs deploy/backend --tail=30   # DB 연결/마이그레이션 에러 없는지
kubectl -n captcha exec deploy/backend -- python -c "
import urllib.request
print(urllib.request.urlopen('http://localhost:8000/health').read())
print(urllib.request.urlopen('http://ai:5000/health').read())"
# 두 줄 다 status ok 계열이면 backend 자체 + backend→ai 연동 성공
```

> backend가 `CrashLoopBackOff`면 십중팔구 환경변수입니다: `kubectl -n captcha logs deploy/backend` 로 어떤 키가 없는지 확인 → `.env.k8s` 수정 → `kubectl -n captcha delete secret app-secret` 후 재생성 → `kubectl -n captcha rollout restart deploy/backend`.

---

## Phase 8. 프론트엔드 + 데모 + Ingress(TLS) — 외부 오픈

### 8-1. 프론트·데모 배포

**[작업]**

```bash
kubectl apply -f 40-frontend.yaml -f 50-ticketing-demo.yaml
kubectl -n captcha rollout status deploy/frontend
kubectl -n captcha rollout status deploy/ticketing-demo
```

### 8-2. Ingress + 인증서

**[작업]**

```bash
kubectl apply -f 60-ingress.yaml
```

**[확인]**

```bash
kubectl -n captcha get ingress                 # ADDRESS에 LB IP
kubectl -n captcha get certificate            # vlur-site-tls READY=True (DNS 전파돼 있으면 1~3분)
# READY가 False로 오래가면:
kubectl -n captcha describe certificaterequest,order,challenge
# → 대부분 "DNS가 아직 LB IP를 안 가리킴" 또는 Phase 4 미완료
```

### 8-3. 최종 스모크 테스트

```bash
curl -sI https://vlur.site/ | head -1                     # HTTP/2 200 (프론트)
curl -s  https://vlur.site/api/health                     # {"status":"ok"} (nginx가 prefix 떼고 백엔드로)
curl -sI https://vlur.site/static/widget/vlur-captcha.js | head -1   # 200 (위젯 번들)
curl -sI https://ticket.vlur.site/ | head -1              # 200 (데모)
```

브라우저에서:

- [ ] https://vlur.site — 메인 페이지, 회원가입/로그인(이메일 인증 포함)
- [ ] 캡차 데모 페이지 — 유형1/2 챌린지 생성·드래그 검증 (backend→ai 실호출 경로)
- [ ] 소셜 로그인 3종 — 콘솔에 리다이렉트 URI를 등록한 뒤에만 성공
- [ ] https://ticket.vlur.site — 예매 흐름에서 캡차 위젯이 뜨는지

### 8-4. 데모 사이트 실제 Site Key 연결

데모가 dev 키(`pk-aicap_dev_testuser_001`)로 빌드되어 있으면 Origin 검증에서 막힐 수 있습니다.

**[작업]**
1. vlur.site 관리자/마이페이지에서 API Key를 발급하고 **도메인을 `ticket.vlur.site`로 등록**
2. 데모 저장소 워크플로우의 `VLUR_PUBLIC_SITE_KEY`를 발급 키로 바꿔 커밋 → CI 재빌드
3. 새 SHA로 이미지 교체:
   ```bash
   kubectl -n captcha set image deploy/ticketing-demo \
     ticketing-demo=kc-sfacspace05.kr-central-2.kcr.dev/team2-repo/vlur-ticketing-demo:sha-<새SHA>
   ```

---

## Phase 9. 운영 (상시 가동) — 모니터링·백업·업데이트

### 9-1. 일상 점검 (하루 1회 권장)

```bash
kubectl -n captcha get pods                    # 전부 Running, RESTARTS 급증 없는지
kubectl top nodes && kubectl top pods -n captcha
kubectl get events -n captcha --sort-by=.lastTimestamp | tail
kubectl -n captcha get certificate            # TLS READY 유지 (cert-manager가 자동 갱신)
```

### 9-2. 백업 확인

```bash
kubectl -n captcha get cronjob db-backup       # 스케줄 0 18 * * * (KST 03:00)
kubectl -n captcha get jobs | tail             # 최근 잡 Completed 인지
# 수동으로 1회 돌려서 검증:
kubectl -n captcha create job db-backup-manual --from=cronjob/db-backup
kubectl -n captcha logs job/db-backup-manual   # "backup done: ..." 확인
```

추가로 카카오클라우드 콘솔에서 **DB 블록 스토리지 볼륨의 스냅샷 스케줄**도 걸어두세요(인프라 레벨 이중 백업).

### 9-3. 업데이트(롤링) & 롤백

새 코드가 develop에 머지되면 CI가 `sha-<새커밋>` 태그로 이미지를 올립니다. 교체는:

```bash
SHA=<새 커밋 전체 SHA>
REG=kc-sfacspace05.kr-central-2.kcr.dev/team2-repo
kubectl -n captcha set image deploy/backend  backend=$REG/vlur-backend:sha-$SHA
kubectl -n captcha set image deploy/frontend frontend=$REG/vlur-frontend:sha-$SHA
kubectl -n captcha set image deploy/ai       ai=$REG/vlur-ai:sha-$SHA
kubectl -n captcha rollout status deploy/backend   # replica 2라 무중단 교체
```

문제가 생기면 즉시 롤백:

```bash
kubectl -n captcha rollout undo deploy/backend
kubectl -n captcha rollout history deploy/backend   # 리비전 확인
```

> DB(vlur-database) 이미지는 초기화 SQL이 바뀌어도 **기존 볼륨에는 재실행되지 않으므로** 이미지 교체 의미가 거의 없습니다. 스키마 변경은 backend의 migrations로 나가야 합니다.

---

## Phase 10. (옵션) AI를 클러스터 밖 GPU-01로 전환

추론 부하가 CPU 파드로 감당이 안 될 때만 필요합니다.

**[작업]**
1. GPU-01(210.109.15.254)에서 AI 컨테이너 실행:
   ```bash
   docker run -d --name vlur-ai --restart unless-stopped -p 5000:5000 \
     kc-sfacspace05.kr-central-2.kcr.dev/team2-repo/vlur-ai:sha-<SHA>
   ```
2. 보안 그룹: **워커 노드 대역 → GPU-01:5000** 인바운드 허용
3. 백엔드가 바라보는 주소 교체:
   ```bash
   kubectl -n captcha patch configmap app-config \
     -p '{"data":{"AI_SERVICE_URL":"http://210.109.15.254:5000"}}'
   kubectl -n captcha rollout restart deploy/backend
   ```
4. 클러스터 안 AI 파드 정리: `kubectl -n captcha scale deploy/ai --replicas=0`

**[확인]**

```bash
kubectl -n captcha exec deploy/backend -- python -c \
  "import urllib.request; print(urllib.request.urlopen('http://210.109.15.254:5000/health', timeout=3).read())"
```

> 되돌리기: AI_SERVICE_URL을 `http://ai:5000`으로 patch → `scale deploy/ai --replicas=2` → backend restart.
> GPU-01은 K8s 관리 밖이므로 장애 시 자동 복구가 없습니다 — `--restart unless-stopped` 필수, 점검 목록에 `docker ps` 추가.

---

## 부록 A. 자주 나는 오류 진단표

| 증상 | 원인 후보 | 확인/조치 |
|---|---|---|
| secret 생성 시 `is not a valid key name` | `.env`에 `#` 없이 쓴 섹션 제목 줄이 있음 | Phase 5-1의 awk 정리를 건너뛴 것 — `.env.k8s`를 다시 생성 |
| `ImagePullBackOff` | regcred 오타·미연결, 태그(전체 SHA) 오타 | `kubectl describe pod` 의 Events, Phase 3-1 재확인 |
| PVC `Pending` 지속 | CSI 미설정 / SC 이름 오타 / WaitForFirstConsumer | `kubectl get sc`, mysql 파드가 스케줄됐는지 |
| backend `CrashLoopBackOff` | app-secret 키 누락/오타, DB 접속 실패 | `logs deploy/backend`, Secret 재생성 후 rollout restart |
| backend는 Ready인데 캡차 검증 실패 | ai 파드 다운, AI_SERVICE_URL 오타 | `exec` 로 `http://ai:5000/health` 호출 |
| Ingress ADDRESS 비어 있음 | Ingress Controller 미설치 / LB 미연결 | Phase 3-3 |
| certificate READY=False | DNS가 LB IP를 안 가리킴, ClusterIssuer 오타 | `dig`, `describe challenge` — HTTP-01은 80 포트로 검증하므로 DNS 필수 |
| 소셜 로그인 redirect_uri mismatch | 콘솔에 프로덕션 URI 미등록 | Phase 5-1의 콘솔 등록 목록 |
| 데모 사이트 캡차 403/Origin 오류 | Site Key의 등록 도메인 ≠ ticket.vlur.site | Phase 8-4 |
| mysql-0 재시작 후 데이터 정상, SQL 안 돔 | 정상 동작 (init은 빈 볼륨에서만) | 스키마 변경은 migrations로 |
| 파드 Evicted/Pending (스케줄 불가) | 노드 리소스 부족 (3×4vCPU/8GB) | `kubectl top nodes`, replica·limits 조정 |
| Let's Encrypt 발급 실패 반복 | 시간당 발급 한도(rate limit) 도달 | 1시간 대기, 그동안 staging issuer로 테스트 |

## 부록 B. 이번 배포에서 로컬(docker-compose)과 달라지는 점

| 항목 | docker-compose (로컬) | Kubernetes (프로덕션) |
|---|---|---|
| DB 호스트 | `db` | `mysql` (app-config가 덮어씀) |
| DB 초기화 | `./database/init` 바인드 마운트 | vlur-database 이미지에 내장 |
| 프론트 | Vite dev 서버(5173) | nginx 정적 서빙+프록시 (frontend/Dockerfile) |
| API 진입 | `localhost:8000` 직접 | `https://vlur.site/api/*` → frontend nginx → backend |
| AI 주소 | `http://ai:5000` | 동일 (Service 이름 유지) — GPU-01 전환 시만 변경 |
| 환경변수 | `.env` 파일 | app-secret(전체) + app-config(토폴로지 값 override) |
| HTTPS | 없음 | Ingress + cert-manager (Let's Encrypt 자동 갱신) |
| 데이터 영속 | 도커 볼륨 | 블록 스토리지 PVC 40Gi + 백업 CronJob + 스냅샷 |

## 부록 C. 한 줄 요약

접속 확인 → CI로 이미지 5종 push → regcred·StorageClass·Ingress Controller·cert-manager 기반 확인 → DNS를 LB로 → `.env.k8s` 도메인 치환 후 Secret 2종 + placeholder 치환 → **mysql → ai → backend → frontend·demo → ingress** 순서로 apply → 스모크 테스트 → 이후엔 `set image`로 롤링 업데이트, 백업은 CronJob+스냅샷 이중으로.
