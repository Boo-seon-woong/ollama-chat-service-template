<div align="center">

[한국어](./README.md) | [ENGLISH](./readme_en.md)

# ollama-chat-service-template

브랜딩 가능한 Ollama 채팅 서비스 템플릿  
(이메일 인증 + 세션 로그인 + 사용자별 메모리 + 단일 장비용 요청 큐)

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.21-black?logo=express&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-API-111111)
![Nodemailer](https://img.shields.io/badge/Nodemailer-SMTP-0A66C2)
![Queue](https://img.shields.io/badge/Chat-Queue-FIFO-8A2BE2)
![Auth](https://img.shields.io/badge/Auth-Session%20Cookie-FF6B6B)
![Storage](https://img.shields.io/badge/Storage-JSON%20Files-2E8B57)
![HTML](https://img.shields.io/badge/UI-HTML/CSS/JS-E34F26?logo=html5&logoColor=white)

</div>

## 문서 안내

- 영문 상세 문서: `readme_en.md`
- 클라이언트 정적 파일 문서: `public/README.md`
- 런타임 데이터 문서: `data/README.md`

## 빠른 시작

1. 의존성 설치

```bash
npm install
```

2. `.env` 값 설정 (`APP_NAME`, `OLLAMA_MODEL`, `MAIL_*` 등)

3. 실행

```bash
npm start
```

4. 브라우저 접속: `http://localhost:3000`

## 핵심 구조

- `server.js`: Express 라우팅/부트스트랩
- `app/config.js`: `.env` 로딩 + 설정값
- `app/store.js`: 사용자/세션/메모리 저장 로직
- `app/chat-service.js`: FIFO 큐 + Ollama 호출

## 동시성 정책

- 여러 클라이언트 요청은 동시에 들어올 수 있습니다.
- 실제 Ollama 호출은 큐에서 **1개씩 순차 처리**됩니다.
- 큐 최대치(`CHAT_QUEUE_MAX_PENDING`) 초과 시 `503`을 반환합니다.

## 기본 API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/chat/history`
- `POST /api/chat/send`

## 메모

이 README는 한국어 메인 안내 문서입니다.  
전체 환경변수 표, API 예시, 운영 체크리스트는 `readme_en.md`에서 확인할 수 있습니다.
