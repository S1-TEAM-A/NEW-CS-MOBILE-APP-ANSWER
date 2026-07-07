# 에스원 Answer — 백엔드 API

VOC 현장 CS 앱의 백엔드. Express + PostgreSQL(없으면 메모리 저장소 폴백).

## 로컬 실행

```bash
cd server
npm install
npm start            # http://localhost:3000 (메모리 모드)
# PORT=8899 node server.js  ← 포트 변경
```

`DATABASE_URL` 환경변수가 있으면 PostgreSQL 사용(부팅 시 테이블 자동 생성 + 96건 VOC·7코드 가이드 자동 시드).

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 상태 확인 (db: postgres/memory) |
| GET | `/api/vocs` | 오늘의 VOC 12건 (6코드×2 랜덤, 저장결과 병합) |
| GET | `/api/vocs/all` | 전체 96건 |
| GET | `/api/vocs/:id` | VOC 상세 |
| GET | `/api/guide/:code` | 접수코드별 조치가이드 |
| POST | `/api/vocs/:id/result` | 조치결과 저장 `{result, compStatus, partFlag, confirmFlag}` |
| POST | `/api/vocs/:id/schedule` | 방문일정 저장 `{time, state, date}` |
| GET | `/api/stats` | 완료율·코드별 통계 |

## Railway 배포

1. Railway → New Project → Deploy from GitHub repo
2. 서비스 Settings → **Root Directory = `server`**
3. 프로젝트에 **PostgreSQL 추가** → 서비스 Variables에 `DATABASE_URL` 연결(Reference)
4. Settings → Networking → **Generate Domain**
5. 프론트(`index.html`)의 `API_BASE`를 생성된 도메인으로 교체

## 프론트 연동

`index.html`의 `API_BASE`가 유효한 URL이면 서버 데이터 사용, 아니면 내장 데이터로 폴백.
로컬 테스트: 브라우저 콘솔에서 `localStorage.setItem('apiBase','http://localhost:8899')` 후 새로고침.
