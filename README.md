# KNUH 야식·조식 신청 대시보드

칠곡경북대학교병원 야식/조식 신청 시스템.

## 역할

- **신청자**: 야식·조식 메뉴를 등록 (여러 날짜 한번에 신청 가능)
- **액팅**: 야식 또는 조식 선택 → 날짜별 신청 목록 확인 → 카드 탭 → **사번 바코드 + 메뉴** 표시 → 폰 그대로 들고 가서 수령
- **관리자**: 신청자에게 노출되는 메뉴 항목을 추가·숨김·삭제 (사번 `22807` 김덕근만)

## 의존성

- **Node.js 22.13 이상** (Node 내장 `node:sqlite` 모듈 사용 — 네이티브 컴파일 불필요)
- **express** (유일한 npm 의존성)

## 기능

### 신청자 (단계형 흐름)

1. **홈 화면**:
   - 신청 0건일 때: 조식·야식 큰 카드 2개로 시작
   - 신청 1건 이상일 때: 상단에 내 신청 현황 카드 목록, 하단에 [조식 신청] [야식 신청] 빠른 버튼
2. **단계 1 - 식사 선택**: 조식 또는 야식
3. **단계 2 - 날짜 선택**: 앞으로 7일 중 다중선택 (오늘/내일/3일 빠른 버튼). 이미 신청된 날은 점 표시
4. **단계 3 - 메뉴 선택**:
   - **조식**: 카테고리 선택(선식/죽/빵/햄버거/닭가슴살/떡볶이/라면/밥) → 슬롯별로 1·2순위 옵션 선택 (탭으로 추가/제거) + "없으면 아무거나 OK" 토글 + 메모(선택)
   - **야식**: 관리자가 등록한 메뉴 칩 또는 직접 입력
5. **완료 화면**: ✅ 신청 결과 + 본인 바코드 바로 보기 / 홈으로

다른 기능:
- 현황 카드 탭 → **본인 바코드 + 메뉴(구조화) 모달** (스와이프로 여러 신청 사이 이동)
- 현황 카드 우측 ✕ → 취소
- 어디서든 좌상단 ‹ 또는 ✕ 로 뒤로/홈으로

### 액팅
- **조식·야식 먼저 선택**, 그 다음 날짜 선택
- 카드에 **슬롯별 우선순위**가 한눈에 보임 (`음료: 1 우유 / 2 두유` 같은 형태)
- 탭 → 흰색 모달에 큰 글씨로 정리된 슬롯 표 + 바코드
- 스와이프로 다음 직원, "수령 완료 · 다음" 버튼으로 자동 진행

### 관리자 (사번 22807만)
- **조식 구조**: 카테고리·슬롯·옵션을 자유롭게 편집
  - 카테고리 추가/숨김/삭제 (이름, 이모지)
  - 카테고리를 펼쳐 슬롯 추가
    - **선택 슬롯**: 옵션 목록(쉼표/줄바꿈 구분) — 신청자가 우선순위로 고름
    - **고정 슬롯**: 고정 텍스트(예: "계란 2개") — 신청자는 선택 안 하고 항상 같이 제공됨
- **야식 메뉴**: 단순 메뉴 칩 추가/숨김/삭제 (기존과 동일)

## 로컬 실행

```bash
npm install
npm start
# http://localhost:3000
```

데이터는 기본적으로 `./data/knuh.db`. `DATABASE_PATH` 환경변수로 변경 가능.

## Railway 배포

### 1) GitHub 푸시
```bash
git init
git add .
git commit -m "init KNUH meal dashboard"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

### 2) Railway 프로젝트
- https://railway.app → **New Project** → **Deploy from GitHub repo**

### 3) **중요**: Volume 마운트 (데이터 영구 보관)
1. 서비스 → **Settings** → **Volumes** → **+ New Volume**, Mount path `/data`
2. **Variables** → `DATABASE_PATH` = `/data/knuh.db`

이걸 안 하면 재배포 시 SQLite 파일이 사라집니다.

### 4) 도메인
- **Settings** → **Networking** → **Generate Domain**

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | Railway가 자동 주입 |
| `DATABASE_PATH` | `./data/knuh.db` | SQLite 파일 경로 |

## 관리자 추가/변경

`server.js` 상단:
```js
const ADMIN_EMPLOYEE_IDS = new Set(['22807']);
```
사번을 추가하거나 변경 후 푸시하면 됩니다.

## 데이터 모델

- `users` (id, employee_id, name, created_at)
- `meal_orders` (id, user_id, meal_type, menu, **service_date**, status, created_at, picked_up_at, picked_up_by)
  - **고유 인덱스**: `(user_id, service_date, meal_type) WHERE status='pending'` → 같은 날·같은 식사 종류에 pending 1건만
- `menu_items` (id, meal_type, name, sort_order, active, created_at)

기존 DB에서 업그레이드 시 `service_date` 컬럼은 자동 추가됩니다 (`created_at`의 날짜로 백필).

## API 요약

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/register` | 등록/갱신 |
| `GET` | `/api/me` | 본인 정보 (`is_admin` 포함) |
| `GET` | `/api/menu-items?meal_type=&include_inactive=` | 메뉴 목록 |
| `POST` | `/api/menu-items` | 메뉴 추가 (관리자) |
| `PATCH` | `/api/menu-items/:id` | 메뉴 수정/숨김 (관리자) |
| `DELETE` | `/api/menu-items/:id` | 메뉴 삭제 (관리자) |
| `POST` | `/api/orders` | 단일 날짜 신청/수정 |
| `POST` | `/api/orders/batch` | 여러 날짜 일괄 신청 |
| `GET` | `/api/orders/my?from=` | 내 신청 (기본: 오늘 이후) |
| `DELETE` | `/api/orders/:id` | 신청 취소 |
| `GET` | `/api/orders/active?meal_type=&date=` | 액팅용 대기 목록 |
| `GET` | `/api/orders/active/summary?days=` | 날짜별 카운트 요약 |
| `POST` | `/api/orders/:id/pickup` | 수령 완료 |
| `POST` | `/api/admin/cleanup` | 7일 전 수령 기록 정리 (관리자) |

인증: `X-Employee-Id` 헤더 (간단 시스템용).

## 바코드

- 클라이언트 사이드 [JsBarcode](https://github.com/lindell/JsBarcode) → **Code128** (사번 그대로)
- 다른 형식 필요 시 `public/app.js`의 `JsBarcode` 호출 `format` 옵션만 변경

## 변경 이력

- **v1.4**: 조식 카테고리·슬롯·우선순위 시스템 (실제 동원 픽업스테이션 메뉴 반영), 관리자가 조식 구조 전체 편집 가능, 액팅에 구조화된 슬롯 우선순위 표시
- **v1.3**: 신청자 단계형 흐름 (조식/야식 → 날짜 → 메뉴 → 완료), 전체 영역 조식·야식 순서로 통일
- **v1.2**: 스와이프 가능한 바코드 뷰어 (액팅·신청자 공용), 수령 완료 시 자동 다음 이동, 신청자도 본인 바코드 빠른 보기, 키보드 단축키 지원
- **v1.1**: 날짜 기능, 관리자 메뉴 관리, 액팅 화면 야식·조식 분리
- **v1.0**: 초기 버전 (Express + node:sqlite)
