# 틈틈이

## AI 답변을 기다리는 몇 초, 커피 한 잔이 됩니다

틈틈이는 AI가 답을 만드는 동안에만 상태줄에 작은 광고 한 줄을 얹습니다. **Claude Code**를 쓸 때 광고 수익의 **절반**이 지갑에 쌓이고, **2,000원**이 모이면 커피 기프티콘을 문자로 받습니다. 회원가입은 없습니다.

```
/plugin marketplace add kennykimtang/teumteumi-cli
/plugin install teumteumi@teumteumi
```

그다음 이렇게 말씀하시면 됩니다.

> 틈틈이 지갑 여기서도 열어줘

플러그인을 넣는 것만으로는 아무것도 바뀌지 않습니다. **말을 거셨을 때** 에이전트가 연결을 대신 해 드립니다.

지갑은 브라우저에서 쓰던 것과 **같은 지갑**이고, 여기서 쌓인 것도 거기로 모입니다.

---

## 세 가지 약속

**쓰던 상태줄을 덮지 않습니다.**
이미 쓰시던 상태줄이 있으면 그대로 두고, 그 뒤에 광고 한 칸이 얹힙니다. 설정 파일은 백업한 뒤에 바꾸고, 다른 설정은 건드리지 않습니다.

**대화를 읽지 않습니다.**
대화·코드·파일 경로·세션 내용은 읽지도, 어디로 보내지도 않습니다. 상태줄을 그리는 데 필요한 것만 씁니다.

**광고라고 말합니다.**
모든 줄에 `광고·AD` 라벨이 붙습니다. 답을 기다리는 동안에만 뜨고, 답이 시작되면 사라집니다.

---

## 쓰는 법

연결이 끝나면 따로 하실 일은 없습니다. 광고는 기다리는 동안 저절로 뜨고, 답이 오면 사라집니다.

상태줄 맨 앞 **⏰** 를 누르면 지갑이 열리고, 광고 문구를 누르면 광고주 페이지로 갑니다. 눌러야 할 의무는 없고 궁금할 때만 쓰시면 됩니다.

브라우저 지갑의 6자리 연결 코드가 있다면 함께 말씀해 주세요. 쓰시던 지갑에 그대로 합쳐집니다.

> 틈틈이 연결해줘. 코드는 A1B2C3

그만 쓰고 싶으실 땐 "틈틈이 그만 쓸래"라고 하시면 됩니다. 저희가 넣은 것만 정확히 걷어내고 쓰시던 상태줄을 되돌려 놓습니다. 플러그인을 지우시기 전에 먼저 해 주세요.

<details>
<summary>가끔 쓰는 명령 (에이전트가 대신 실행합니다)</summary>

| 명령 | 하는 일 |
|---|---|
| `teumteumi wallet` | 지갑 열기 |
| `teumteumi ad` | 지금 뜬 광고 열기 |
| `teumteumi link <코드>` | 브라우저 지갑과 합치기 |
| `teumteumi verify` | 설치본·서버본 해시와 서명 확인 |
| `teumteumi remove` | 되돌리기 |

</details>

---

## 확인해 보셔도 됩니다

이 저장소에는 **클라이언트 전문이 그대로** 들어 있습니다(`statusline.mjs`). 설치 전에 읽으실 수 있고, 서버에서 코드를 받아와 실행하지 않습니다.

릴리즈는 **Ed25519로 서명**되어 있어서, 저희 키로 서명된 판이 아니면 설치되지 않습니다. 1바이트만 달라도 거부합니다.

```
teumteumi verify
```

서명이 못 막는 것이 하나 있습니다. **저희가 특정한 분에게만 다른 판을 보내는 경우**입니다. 그건 서명이 아니라 공개로만 드러나므로, 모든 릴리즈의 해시를 배포 서버 **바깥**에 올려 둡니다.

- 해시·공개키·검증 절차 → https://github.com/kennykimtang/teumteumi-cli-releases
- 클라이언트 전문 → https://teumteumi.up.railway.app/cli/statusline.mjs
- 변경 내역 → https://teumteumi.up.railway.app/cli/CHANGELOG.md

---

## 자주 묻는 것

<details>
<summary><b>연결하면 무엇이 바뀌나요?</b></summary>

| 호스트 | 파일 | 바뀌는 것 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `statusLine`에 광고 한 칸, `hooks.Stop`에 한 줄 |
| Antigravity CLI | `~/.gemini/antigravity-cli/settings.json` | `statusLine` 하나만 |

`hooks.Stop`은 **응답이 끝난 시각만** 기록합니다. 이게 있어야 "광고는 기다리는 동안에만"이 지켜집니다. 기존 훅은 보존됩니다.

저희가 만드는 파일은 `~/.teum/` 아래에만 있습니다. 이 기기에 없는 CLI의 설정 파일은 만들지 않습니다.
</details>

<details>
<summary><b>기프티콘은 어떻게 받나요?</b></summary>

2,000원이 모이면 지갑에서 쿠폰 받을 곳(휴대폰 번호)을 한 번 등록해 두시면 됩니다. 그다음부터는 버튼 한 번이면 커피 기프티콘이 문자로 옵니다.

국내 문자로 보내드리므로 한국 휴대폰 번호로 받으실 수 있습니다.
</details>

<details>
<summary><b>브라우저에서도 쌓이나요?</b></summary>

네. 크롬 확장을 쓰시면 ChatGPT·Claude·Gemini에서도 같은 지갑에 쌓입니다. 연결 코드로 합치면 하나의 지갑이 됩니다.

→ https://chromewebstore.google.com/detail/mdoaankhdpikcaenaghhopcomifkmpbm
</details>

<details>
<summary><b>Antigravity CLI인데 안 보여요</b></summary>

Antigravity CLI는 설정이 반영되려면 **완전히 껐다 켜야** 합니다. 새 탭이 아니라 CLI 자체를 종료했다가 다시 실행해 주세요.
</details>

<details>
<summary><b>알아서 갱신되나요?</b></summary>

하루 한 번 새 판이 있는지 확인하고, **저희 키로 서명된 판일 때만** 갱신합니다. 갱신되면 상태줄에 한 줄로 알려 드립니다.

이건 설계상 원격 코드 실행이라, 끄는 방법도 함께 둡니다.

| 환경변수 | 하는 일 |
|---|---|
| `TEUM_CLI_NO_UPDATE=1` | 자동 갱신 끄기 |
| `TEUM_CLI_ACCRUAL=0` | 적립·광고 끄기 |
| `TEUM_CLI_DEBUG=1` | 진단 출력 |
</details>

---

틈틈이 → https://teumteumi.up.railway.app/ · npm → https://www.npmjs.com/package/teumteumi

<sub><b>English</b> — A Claude Code plugin that adds a status line for Claude Code, showing one small ad line while you wait for a response and crediting half of the ad revenue to your wallet. Installing the plugin changes nothing on its own: it adds a skill so the agent connects it when you ask. The full client source is in this repository (`statusline.mjs`) and signed with Ed25519; run `teumteumi verify` to check it against the published hashes. It never reads your conversations, code, or file paths. Rewards are Korean coffee gift certificates delivered by SMS.</sub>

MIT
