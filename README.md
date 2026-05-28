# Network Performance Inspector

서버(예: Riyadh)와 클라이언트 기기 간 통신 성능을 한 페이지에서 실시간으로 시각화합니다.

- 상단 좌: 합성 비디오 스트림 (서버 타임스탬프 박힌 JPEG, WebSocket binary)
- 상단 우: Ping RTT / Streaming Delay / Bandwidth / 실측 FPS 차트
- 하단: 서버/클라이언트 IP·위치·ASN, ping 통계, navigator.connection, mtr 트레이스 결과
- Bitrate / FPS / 해상도 / JPEG quality 실시간 조절 (기본 500 KB/s, 30fps, 720p)
- NTP-식 클럭 오프셋 보정으로 단방향 streaming delay 정밀 측정

## 실행

### Docker (권장 — 자동 재시작/백그라운드)

```bash
docker compose up -d --build
# 로그
docker compose logs -f
# 정지
docker compose down
```

http://<server-ip>:5000 접속.

### 호스트 venv (개발용)

```bash
./run.sh
```

## 방화벽
서버 측에서 `5000/tcp` 인바운드 오픈 필요.

## 측정 정의
- **Ping RTT**: WebSocket으로 100ms마다 ping/pong, `c2 - c1`.
- **Clock offset**: Cristian 알고리즘. 최소 RTT 샘플의 offset을 채택, 5초마다 갱신.
- **Streaming Delay**: `clientRecv - (serverFrameTs + offset)`. 단방향, 클럭 보정 포함.
- **Bandwidth**: 직전 1초간 WebSocket 수신 byte / 1024.
- **Actual FPS**: 직전 1초간 수신 프레임 수.
- **Jitter**: 최근 100 RTT 샘플의 표준편차.

## 한계
- IP geolocation은 ip-api.com 무료 endpoint (http-only, rate-limited). 차단 환경이면 해당 칸 비어 있음.
- 합성 JPEG는 실제 H.264와 코덱 특성이 달라, 정확한 측정에는 유리하지만 시각 체감은 다름.
- mtr의 ICMP 차단 hop은 `???`로 표시됨.
- 한 페이지/한 클라이언트 기준. 다중 동시 클라이언트 측정은 범위 밖.
