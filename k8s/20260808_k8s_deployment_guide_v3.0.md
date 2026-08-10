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
- **AI 추론은 클러스터 안 파드**로 배포하며 **CPU에서 돕니다**. 클러스터에 GPU 노드 풀(`team2-gpu`)이 있지만 현재 추론 코드는 GPU를 쓸 수 없습니다 — 자세한 이유와 대응은 Phase 10을 보세요.
- 챌린지 상태는 DB(captchas 테이블)에 저장되므로 backend를 2 replica로 띄워도 검증이 깨지지 않습니다.

### 0-2. 배포 산출물 (이 저장소 `k8s/manifests/`)

| 파일 | 내용 |
|---|---|
| `00-namespace.yaml` | `captcha` 네임스페이스 |
| `05-app-config.yaml` | 비민감 설정 ConfigMap (DB_HOST=mysql, AI_SERVICE_URL 등) |
| `10-mysql.yaml` | MySQL StatefulSet + 헤드리스 Service + PVC 40Gi (이미지: vlur-database — 초기화 SQL 내장) |
| `20-ai.yaml` | AI 추론 Deployment(×2) + Service |
| `25-llm.yaml` | 챗봇용 vLLM Deployment + Service + 모델 캐시 PVC 50Gi (GPU 노드, Phase 11에서 별도 배포) |
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
| `__GIT_SHA__` | backend·ai·frontend 이미지를 빌드한 커밋 전체 SHA | `git rev-parse upstream/develop` |
| `__DB_GIT_SHA__` | **vlur-database 이미지**를 빌드한 커밋 전체 SHA (위와 다를 수 있음) | Actions의 `Database Image Build` 최근 실행 — Phase 2-2 |
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
kubectl get nodes        # 노드 4대(일반 3 + GPU 1)가 STATUS=Ready
kubectl cluster-info     # 컨트롤 플레인 응답
```

노드 이름은 노드 풀 이름이 아니라 `host-10-0-2-xx` 형태로 나옵니다. 어느 풀 소속인지는 Phase 3-0의 `-L` 옵션으로 확인합니다.

> 안 되면 아래 순서로 점검하세요. 실제로 겪은 것들입니다.
> - `dial tcp [::1]:8080: connect: connection refused` → kubeconfig가 안 잡힌 것. `~/.kube/config`에 있는지 확인
> - `operation not permitted` → macOS가 Downloads 폴더를 보호 중. Finder로 파일을 홈 폴더로 옮긴 뒤 `~/.kube/config`로 이동
> - `executable kic-iam-auth not found` → 카카오클라우드 인증 헬퍼 미설치(아래 참조)
> - `yaml: line N: mapping values are not allowed` → kubeconfig 들여쓰기 오류. `env:`는 `command:`와 같은 열이어야 함

**[참고] kic-iam-auth 설치 (macOS Apple Silicon)**

카카오클라우드는 kubeconfig에 토큰을 넣지 않고, 이 헬퍼가 IAM에서 매번 토큰을 받아오는 방식입니다. 브라우저로 받으면 Gatekeeper 격리 속성이 붙어 막히므로 `curl`로 받는 편이 깔끔합니다.

```bash
mkdir -p ~/bin
curl -fsSL -o ~/bin/kic-iam-auth \
  "https://objectstorage.kr-central-2.kakaocloud.com/v1/c11fcba415bd4314b595db954e4d4422/public/docs/binaries-kic-iam-auth/Mac%20ARM_64%2064Bit/kic-iam-auth"
chmod +x ~/bin/kic-iam-auth
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```

새 터미널을 연 뒤, `~/.kube/config`의 `env: null`을 IAM 액세스 키로 채웁니다(들여쓰기는 `command:`와 같은 6칸).

```yaml
      env:
        - name: OS_AUTH_URL
          value: https://iam.kakaocloud.com/identity/v3
        - name: OS_AUTH_TYPE
          value: v3applicationcredential
        - name: OS_APPLICATION_CREDENTIAL_ID
          value: <IAM 액세스 키 ID>
        - name: OS_APPLICATION_CREDENTIAL_SECRET
          value: <IAM 시크릿>
        - name: OS_REGION_NAME
          value: kr-central-2
```

> 액세스 키는 콘솔 IAM에서 새로 발급합니다. GitHub Secrets에 등록된 `KCR_*` 키는 **값을 다시 읽을 수 없어** 재사용할 수 없습니다.
> 이 파일에는 시크릿이 평문으로 들어가니 `chmod 600 ~/.kube/config`를 유지하고 절대 커밋하지 마세요.

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

### 2-2. 이미지 4개의 태그 확인

워크플로우는 3개인데 이미지는 4개입니다. `Backend + AI`가 두 개를 만들기 때문입니다.

| 워크플로우 | 만드는 이미지 | 쓰이는 placeholder |
|---|---|---|
| `Backend + AI Image Build` | `vlur-backend`, `vlur-ai` | `__GIT_SHA__` |
| `Frontend Image Build` | `vlur-frontend` | `__GIT_SHA__` |
| `Database Image Build` | `vlur-database` | `__DB_GIT_SHA__` |

**`vlur-database`만 태그를 따로 관리합니다.** 이 워크플로우는 `database/` 폴더가 바뀔 때만 도는데, 그 폴더는 몇 주씩 안 바뀌는 게 정상이기 때문입니다. SQL 내용이 그대로면 옛 태그가 곧 최신이므로 **억지로 재빌드할 필요가 없습니다.**

**[작업] 두 SHA를 확인해 메모합니다**

```bash
# 1) backend·ai·frontend용 — develop HEAD
git fetch upstream && git rev-parse upstream/develop

# 2) 실제 빌드된 이미지들의 커밋 확인
curl -sL "https://api.github.com/repos/kakao-NoBot/AI-Captcha/actions/runs?per_page=30" \
  | python3 -c "
import json,sys
for r in json.load(sys.stdin)['workflow_runs']:
    print(f\"{r['name'][:24]:26} {str(r.get('conclusion')):8} {r['head_sha']}\")"
```

두 번째 출력에서 이렇게 읽습니다.

- `Frontend Image Build`와 `Backend + AI Image Build`의 최신 성공 SHA → **`__GIT_SHA__`** (1번 결과와 같아야 정상) : 209f97dc3e912bd6683c4c83f4fca1e49ce50e86
- `Database Image Build`의 최신 성공 SHA → **`__DB_GIT_SHA__`** : c03634e203a001db403fbf14acab0b6a17c2ccfd

**[확인]** 두 SHA 모두 40자리 전체를 적어두세요. 태그는 `sha-` 뒤에 전체 SHA가 붙습니다.

> **`Run workflow` 버튼이 안 보이는 이유**: GitHub은 워크플로우 파일이 **기본 브랜치(main)** 에 있을 때만 수동 실행 버튼을 노출합니다. 이 저장소의 워크플로우는 `develop`에만 있어서 세 개 모두 버튼이 없습니다. 그래서 이 가이드는 수동 실행이 아니라 **이미 빌드된 태그를 그대로 쓰는** 방식으로 진행합니다.
>
> 굳이 특정 이미지를 새로 빌드해야 한다면 해당 경로(`database/` 등)에 아무 변경이나 만들어 develop에 push하면 트리거됩니다. 앞으로 수동 실행을 쓰고 싶다면 워크플로우 파일들을 `main`에도 머지해 두세요.
>
> backend·ai·frontend는 배포 직전에 develop에 push가 일어나면 SHA가 또 달라집니다. 팀에 "develop 잠깐 멈춰달라"고 공지해두는 편이 안전합니다.

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

## Phase 3. 클러스터 기반 — 노드 풀 · imagePullSecret · CSI · Ingress Controller(+cert-manager)

### 3-0. 노드 풀 확인과 GPU 노드 격리 (중요)

클러스터에 노드 풀이 둘 있습니다.

| 노드 풀 | 인스턴스 | 용도 |
|---|---|---|
| `team2-node-pool2` | t1i.xlarge (일반 VM) | **이 서비스의 모든 파드가 여기서 돌아야 합니다** |
| `team2-gpu` | gn1i.4xlarge (GPU) | 현재 이 서비스가 쓰지 않습니다 (Phase 10 참조) |

**[작업]** GPU 노드에 taint가 걸려 있는지 확인합니다. taint가 없으면 스케줄러는 GPU 노드를 그냥 "자원 많은 노드"로 보기 때문에, **MySQL이나 프론트엔드 같은 파드가 비싼 GPU 노드에 올라가 버립니다.**

```bash
kubectl get nodes -L kakaocloud.com/node-pool-name    # 노드가 어느 풀 소속인지
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINTS:.spec.taints'
```

- GPU 노드의 TAINTS에 `nvidia.com/gpu` 류의 `NoSchedule`이 이미 있으면 → **그대로 두고 3-1로 진행**합니다. 우리 파드는 toleration이 없으니 자동으로 일반 노드에만 올라갑니다.
- TAINTS가 `<none>`이면 → 아래 명령으로 직접 격리합니다.

```bash
GPU_NODE=$(kubectl get nodes -l kakaocloud.com/node-pool-name=team2-gpu -o name | head -1)
kubectl taint "$GPU_NODE" workload=gpu:NoSchedule
```

> taint 하나로 막는 방식을 택한 이유는, 매니페스트 5개에 각각 `nodeSelector`를 넣는 것보다 관리 지점이 하나뿐이고 나중에 파드를 추가해도 자동으로 적용되기 때문입니다. 되돌리려면 명령 끝에 `-` 를 붙입니다(`kubectl taint "$GPU_NODE" workload=gpu:NoSchedule-`).

**[확인]** 배포를 끝낸 뒤(Phase 8 이후) 파드가 실제로 어디에 떴는지 봅니다.

```bash
kubectl -n captcha get pods -o wide    # NODE 열이 전부 team2-node-pool2 계열이어야 정상
```

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
# __DB_GIT_SHA__를 __GIT_SHA__보다 먼저 치환할 것 — 반대로 하면 __GIT_SHA__ 패턴이
# __DB_GIT_SHA__ 안의 뒷부분과도 매치돼서 태그가 깨진다.
sed -i '' "s/__DB_GIT_SHA__/<Database Image Build의 커밋 전체 SHA>/g" 10-mysql.yaml
sed -i '' "s/__GIT_SHA__/<develop HEAD 커밋 전체 SHA>/g" *.yaml
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

## Phase 10. 캡차 판별 AI는 GPU를 쓰지 않습니다

클러스터에 GPU 노드 풀(`team2-gpu`, gn1i.4xlarge)이 있지만, **드래그 봇 판별 AI 파드는 GPU에 올리지 않습니다.** 코드가 GPU를 쓸 수 없는 구조이기 때문입니다. 배포 중에 "GPU를 왜 안 쓰지?"라는 질문이 나올 수 있어 근거를 남겨둡니다. GPU 노드는 대신 챗봇 LLM이 사용합니다(Phase 11).

### 10-1. 왜 GPU를 쓸 수 없나

서빙 경로의 추론이 **PyTorch가 아니라 NumPy로 구현**되어 있습니다.

- [AI/ml/ensemble/](../AI/ml/ensemble/) 안의 `cnn_np_forward.py`, `bilstm_np_forward.py`가 실제 forward 연산을 담당하며, 이 파일들과 [AI/services/drag_classifier.py](../AI/services/drag_classifier.py)에는 `import torch`가 없습니다.
- torch는 오직 체크포인트를 **읽을 때만** 쓰이고, 읽는 즉시 `.detach().cpu().numpy()`로 NumPy 배열로 변환됩니다([ensemble_predictor.py:99](../AI/ml/ensemble/ensemble_predictor.py#L99) `from_torch_checkpoint`, `map_location="cpu"` 고정).
- [AI/Dockerfile](../AI/Dockerfile)도 CPU 전용 torch(`--index-url .../whl/cpu`)를 설치합니다.

즉 GPU 노드에 파드를 올려도 **CUDA를 타는 연산이 한 줄도 없어서 속도가 그대로**입니다. 비싼 노드만 점유하게 됩니다.

또 이 워크로드는 애초에 GPU가 필요한 규모가 아닙니다. 모델은 2.3MB이고, 입력은 드래그 궤적 한 건(63스텝 시퀀스)이라 CPU에서 밀리초 단위로 끝납니다. 백엔드의 호출 타임아웃도 3초로 넉넉합니다.

### 10-2. 그래서 지금 할 일

**GPU 노드를 격리해 두는 것**뿐입니다(Phase 3-0). 놔두면 MySQL이나 프론트엔드가 그 노드에 스케줄돼 자원만 낭비합니다.

### 10-3. 나중에 GPU를 정말 쓰려면

트래픽이 늘어 CPU 추론이 병목이 된다면 그때 아래 순서로 검토합니다. **코드 변경이 선행**되어야 하므로 배포 담당이 단독으로 결정할 일은 아닙니다.

1. 추론을 torch forward로 다시 구현하고 `.to("cuda")` 경로를 넣기 (NumPy 구현과 결과가 일치하는지 회귀 테스트 필수 — 임계값 판정이 바뀌면 봇 탐지 정확도가 달라집니다)
2. `AI/Dockerfile`의 torch를 CUDA 빌드로 교체
3. 클러스터에 NVIDIA device plugin 설치 확인: `kubectl get pods -n kube-system | grep -i nvidia`
4. `20-ai.yaml`에 GPU 요청과 toleration 추가:
   ```yaml
   resources:
     limits:
       nvidia.com/gpu: 1
   tolerations:
     - key: workload          # Phase 3-0에서 건 taint와 맞출 것
       value: gpu
       effect: NoSchedule
   ```

> 그 전까지는 **부하가 늘면 GPU가 아니라 `kubectl -n captcha scale deploy/ai --replicas=N` 으로 CPU 파드를 늘리는 게** 맞는 대응입니다. 무상태 서비스라 수평 확장이 그대로 먹힙니다.

---

## Phase 11. 챗봇 자체 호스팅 (GPU 노드 활용)

챗봇을 OpenAI API 대신 **GPU 노드에서 돌리는 vLLM**으로 옮깁니다. 얻는 것은 API 비용 제거와 외부 의존 제거이고, 노는 GPU 노드가 여기서 쓰입니다.

vLLM은 OpenAI와 **동일한 `/v1/chat/completions` 스키마**를 제공합니다. 그래서 [chatbot.py](../backend/routers/chatbot.py)의 호출 코드는 그대로 두고 주소만 바꿔 끼우는 구조로 만들어져 있습니다.

> 이 Phase는 **서비스 배포(Phase 1~9)가 끝난 뒤 별도로** 진행해도 됩니다. 실패해도 `CHATBOT_API_URL`을 지우면 즉시 OpenAI로 돌아가므로(11-5), 서비스 오픈을 막지 않습니다.

### 11-1. GPU 사용 가능 여부 확인

**[작업]** GPU 자원이 스케줄러에 보이는지부터 봅니다.

```bash
# 1) 노드가 GPU를 자원으로 노출하는가
kubectl get nodes -o custom-columns='NODE:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'

# 2) device plugin 파드가 떠 있는가
kubectl get pods -n kube-system | grep -i nvidia
```

- GPU 열에 `1`이 보이면 → 11-2로 진행합니다. (이 클러스터는 GPU 1장 구성입니다 — 11-6의 제약을 함께 읽으세요.)
- `<none>`이거나 device plugin이 없으면 → 카카오클라우드 콘솔의 GPU 노드 풀 안내에 따라 NVIDIA device plugin을 설치해야 합니다. **이게 없으면 `nvidia.com/gpu` 요청이 영원히 Pending입니다.**

**[확인]** GPU 사양(특히 VRAM)을 직접 봅니다. 다음 단계의 모델 선택이 여기서 갈립니다.

```bash
kubectl run gpu-check --rm -it --restart=Never \
  --image=nvidia/cuda:12.4.0-base-ubuntu22.04 \
  --overrides='{"spec":{"tolerations":[{"key":"workload","value":"gpu","effect":"NoSchedule"}],"containers":[{"name":"gpu-check","image":"nvidia/cuda:12.4.0-base-ubuntu22.04","command":["nvidia-smi"],"resources":{"limits":{"nvidia.com/gpu":1}}}]}}'
```

### 11-2. 모델 선택

`25-llm.yaml`의 기본값은 **Qwen2.5-7B-Instruct**입니다. 한국어 응대 품질이 준수하면서 단일 GPU에 올라가는 절충점입니다. 11-1에서 확인한 VRAM에 맞춰 조정하세요.

| VRAM | 권장 `MODEL_ID` | 비고 |
|---|---|---|
| 24GB 이상 | `Qwen/Qwen2.5-7B-Instruct` | 기본값, 그대로 진행 |
| 16GB 내외 | `Qwen/Qwen2.5-7B-Instruct` + `--gpu-memory-utilization=0.92`, `--max-model-len=2048` | 빠듯하면 아래로 |
| 12GB 이하 | `Qwen/Qwen2.5-3B-Instruct` | 품질은 떨어지지만 FAQ 응대에는 충분 |

이 챗봇은 고정된 시스템 프롬프트로 서비스 FAQ만 답하고 응답이 3~5문장으로 제한되어 있어, 모델 크기에 대한 요구가 높지 않습니다. **작은 모델부터 시작해 품질을 보고 올리는 편**이 안전합니다.

### 11-3. 배포

**[작업]**

```bash
cd k8s/manifests
sed -i '' "s/__STORAGE_CLASS__/<StorageClass 이름>/g" 25-llm.yaml   # 아직 안 했다면
kubectl apply -f 25-llm.yaml
kubectl -n captcha get pods -l app=llm -w
```

**최초 기동은 10~30분 걸립니다.** 모델 가중치 수 GB를 HuggingFace에서 받기 때문입니다. `startupProbe`를 30분까지 기다리도록 잡아뒀으니 그 사이 `Running`이지만 `READY 0/1`인 상태가 정상입니다. 진행 상황은 로그로 봅니다.

```bash
kubectl -n captcha logs -f deploy/llm
```

받은 가중치는 `llm-model-cache` PVC에 남으므로 **다음 재시작부터는 1~2분**이면 뜹니다.

**[확인]**

```bash
kubectl -n captcha get pods -l app=llm      # READY 1/1
kubectl -n captcha exec deploy/backend -- python -c "
import json, urllib.request
req = urllib.request.Request('http://llm:8000/v1/chat/completions',
    data=json.dumps({'model':'vlur-chatbot','messages':[{'role':'user','content':'안녕하세요'}],'max_tokens':50}).encode(),
    headers={'Content-Type':'application/json'})
print(json.load(urllib.request.urlopen(req, timeout=60))['choices'][0]['message']['content'])"
```

한국어 답변이 나오면 백엔드에서 LLM까지 경로가 뚫린 것입니다.

### 11-4. 백엔드를 자체 호스팅으로 전환

`05-app-config.yaml`에 `CHATBOT_API_URL`, `CHATBOT_MODEL`이 이미 들어 있습니다. Phase 5-3에서 apply했다면 백엔드를 재시작하기만 하면 됩니다.

**[작업]**

```bash
kubectl apply -f 05-app-config.yaml       # 아직 반영 안 됐다면
kubectl -n captcha rollout restart deploy/backend
kubectl -n captcha rollout status deploy/backend
```

**[확인]** 실제 서비스 경로로 챗봇을 호출해 봅니다.

```bash
curl -s https://vlur.site/api/chatbot \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"요금제 알려주세요"}]}'
```

브라우저에서도 챗봇 위젯을 열어 **답변 내용이 서비스 정보(요금제, API Key 발급 등)와 맞는지** 확인하세요. 여기서 품질이 기대에 못 미치면 11-2의 더 큰 모델로 올리거나, 되돌리면 됩니다.

### 11-5. 되돌리기 (OpenAI로 복귀)

품질이 부족하거나 GPU 노드에 문제가 생기면 즉시 되돌릴 수 있습니다. `CHATBOT_API_URL`이 없으면 코드가 OpenAI 기본값으로 돌아가고, `app-secret`의 `OPENAI_API_KEY`를 다시 씁니다.

```bash
kubectl -n captcha patch configmap app-config \
  --type=json -p='[{"op":"remove","path":"/data/CHATBOT_API_URL"},{"op":"remove","path":"/data/CHATBOT_MODEL"}]'
kubectl -n captcha rollout restart deploy/backend
```

> 그래서 **`OPENAI_API_KEY`는 자체 호스팅으로 넘어간 뒤에도 `.env`에 남겨두세요.** 지우면 되돌릴 수단이 없어집니다.
> GPU 노드를 정비할 일이 있으면 `kubectl -n captcha scale deploy/llm --replicas=0`으로 내렸다가 다시 올리면 됩니다.

### 11-6. GPU가 1장이라는 제약 — 재학습과 시간을 나눠 씁니다

이 클러스터의 GPU는 **1장**입니다. vLLM이 그 1장을 24시간 붙잡고 있으므로, 나중에 모델 재학습 Job이 GPU를 요청하면 **vLLM이 놓아줄 때까지 `Pending`에 걸립니다.** 두 작업을 동시에 돌릴 수 없습니다.

재학습은 주 1회~월 1회면 충분한 작업이라, 새벽에 잠깐 교대하는 것으로 해결됩니다. 순서는 이렇습니다.

```bash
# 1) 챗봇을 OpenAI로 임시 전환 — 사용자는 차이를 느끼지 못한다
kubectl -n captcha patch configmap app-config \
  --type=json -p='[{"op":"remove","path":"/data/CHATBOT_API_URL"},{"op":"remove","path":"/data/CHATBOT_MODEL"}]'
kubectl -n captcha rollout restart deploy/backend

# 2) GPU 반납
kubectl -n captcha scale deploy/llm --replicas=0

# 3) 재학습 Job 실행 (학습 스크립트 확보 후 작성 예정)

# 4) 학습이 끝나면 역순 복구
kubectl -n captcha scale deploy/llm --replicas=1
kubectl apply -f 05-app-config.yaml
kubectl -n captcha rollout restart deploy/backend
```

> 이 4단계를 CronJob 하나로 묶으면 자동화됩니다. 학습이 도는 몇 시간만 OpenAI API를 쓰므로 비용도 미미합니다. **챗봇을 먼저 OpenAI로 돌려놓는 1번 단계를 빠뜨리면** 그 시간 동안 챗봇이 502를 냅니다.

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
| 파드 Evicted/Pending (스케줄 불가) | 일반 노드 풀 자원 부족 | `kubectl top nodes`, replica·limits 조정 |
| 파드가 GPU 노드에 떠 있음 | GPU 노드에 taint 없음 | Phase 3-0의 taint 적용 후 `rollout restart` |
| llm 파드가 계속 `Pending` | device plugin 없음 / taint·toleration 키 불일치 | Phase 11-1, `describe pod`의 Events |
| llm이 `Running`인데 `READY 0/1` 지속 | 모델 다운로드 중 (최초 10~30분은 정상) | `logs -f deploy/llm`로 진행률 확인 |
| llm `CrashLoopBackOff` (CUDA OOM) | 모델이 VRAM보다 큼 | Phase 11-2 표대로 모델·`max-model-len` 축소 |
| 챗봇 503 "설정되지 않았습니다" | CHATBOT_API_URL 없고 OPENAI_API_KEY도 없음 | app-config 반영 후 `rollout restart deploy/backend` |
| Let's Encrypt 발급 실패 반복 | 시간당 발급 한도(rate limit) 도달 | 1시간 대기, 그동안 staging issuer로 테스트 |

## 부록 B. 이번 배포에서 로컬(docker-compose)과 달라지는 점

| 항목 | docker-compose (로컬) | Kubernetes (프로덕션) |
|---|---|---|
| DB 호스트 | `db` | `mysql` (app-config가 덮어씀) |
| DB 초기화 | `./database/init` 바인드 마운트 | vlur-database 이미지에 내장 |
| 프론트 | Vite dev 서버(5173) | nginx 정적 서빙+프록시 (frontend/Dockerfile) |
| API 진입 | `localhost:8000` 직접 | `https://vlur.site/api/*` → frontend nginx → backend |
| AI 주소 | `http://ai:5000` | 동일 (Service 이름 유지), CPU 추론도 동일 |
| 환경변수 | `.env` 파일 | app-secret(전체) + app-config(토폴로지 값 override) |
| HTTPS | 없음 | Ingress + cert-manager (Let's Encrypt 자동 갱신) |
| 데이터 영속 | 도커 볼륨 | 블록 스토리지 PVC 40Gi + 백업 CronJob + 스냅샷 |

## 부록 C. 한 줄 요약

접속 확인 → CI로 이미지 5종 push → regcred·StorageClass·Ingress Controller·cert-manager 기반 확인 → DNS를 LB로 → `.env.k8s` 도메인 치환 후 Secret 2종 + placeholder 치환 → **mysql → ai → backend → frontend·demo → ingress** 순서로 apply → 스모크 테스트 → 이후엔 `set image`로 롤링 업데이트, 백업은 CronJob+스냅샷 이중으로.
