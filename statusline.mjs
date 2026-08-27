#!/usr/bin/env node
/**
 * 틈틈이 × Claude Code — "AI가 생각하는 동안, 터미널에서도 틈틈이"
 * (정본. 서버가 /cli/statusline.mjs 로 서빙 — npm 배포 없이 curl 한 줄/에이전트 설치.)
 * 
 * (이 파일은 공개 서빙본이다. 설계 의도·로드맵·내부 문서 참조는 여기 적지 않는다 —
 *  카피캣에게 가장 값진 건 코드가 아니라 "왜 그렇게 했는지"다. 그건 레포 안에만 둔다.)
 *
 * 모드:
 *   (인자 없음)      상태줄 렌더 — 기존 상태줄을 보존한 채 광고 1줄을 "얹는다"(뺏지 않는다).
 *   setup [코드]     settings.json 백업 → statusLine 얹기 설치 → (코드 있으면) 지갑 링크. 멱등.
 *   link <코드>      이 터미널을 마더 페이지 지갑에 연결(크로스지면 단일지갑).
 *   wallet | open    내 통합 지갑(마더 페이지)을 브라우저로 연다.
 *   ad | click       지금 상태줄에 뜬 광고를 브라우저로 연다(클릭 집계 포함).
 *   remove           설치 원복(기존 statusLine 복원). 적립 데이터(~/.teum)는 보존.
 *   selftest         "이 환경에서 실제로 실행되는가"만 확인하고 TEUM_OK를 찍는다(설치 검증용).
 *
 * 지면: **Claude Code**(`~/.claude/settings.json`)와 **Gemini CLI**(`~/.gemini/antigravity-cli/`).
 *   호스트는 stdin payload가 스스로 밝힌다(`agent_state`가 있으면 Gemini). 설정 플래그 없음.
 *
 * 뷰어빌리티: 광고 1건당 노출 1회. **광고는 대기 중에만 표시되고, 보고되는 표시시간은
 *   "기다리는 동안 떠 있던 시간"의 누적**(≥ MIN_VISIBLE_MS 3s)이다. 유휴 시간은 세지 않는다.
 * 서버가 servedAt 경과시간 캡·≥1s·레이트리밋·일 적립캡 재강제(클라 위조 무력).
 * 프라이버시: 코드/대화/세션 내용을 읽지 않는다. stdin(세션 JSON)은 소비만.
 * 킬스위치: TEUM_CLI_ACCRUAL=0(표시만).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync, unlinkSync, readdirSync, statSync, realpathSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash, verify as verifySignature, createPublicKey } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

/**
 * 이 스크립트의 판번호. 서버의 판번호와 다르면 스스로 새 판으로 갈아탄다(아래 selfUpdate).
 * ⚠️ 스크립트를 고칠 때마다 올릴 것 — 안 올리면 갱신이 전파되지 않는다.
 */
const VERSION = '14';

/**
 * 릴리즈 서명 공개키(Ed25519). **자가 갱신은 이 키로 서명된 판만 받는다.**
 *
 * 자가 갱신은 구조적으로 "우리 서버가 남의 기기에서 코드를 실행시키는 것"이다. 서명이 없으면
 * 그 권한이 **서버를 장악한 누구에게나** 넘어간다(호스팅 계정·배포 파이프라인·중간자).
 * 개인키는 배포 서버에 없고 릴리즈 담당자의 기기에만 있으므로, **서버가 털려도 유저 기기까지
 * 가지 못한다.**
 *
 * ⚠️ 서명이 막지 **못하는** 것: 우리 자신이 특정 유저에게만 다른 코드를 서명해 보내는 것.
 *    그건 암호가 아니라 **공개로만** 탐지된다 → 모든 릴리즈의 SHA-256을 우리 서버가 아닌
 *    곳에 올린다: https://github.com/kennykimtang/teumteumi-cli-releases
 *    `statusline.mjs verify` 로 내 기기의 해시를 직접 찍어 그 목록과 대조할 수 있다.
 */
const RELEASE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAb0Au+iYXxIPyGv4gxuBq1J7pBioXsjj3qdnu8vkXM2E=
-----END PUBLIC KEY-----`;
const RELEASES_URL = 'https://github.com/kennykimtang/teumteumi-cli-releases';

const API = process.env.TEUM_API_BASE ?? 'https://teumteumi.up.railway.app';
const CACHE_TTL_MS = Number(process.env.TEUM_CLI_CACHE_TTL_MS ?? 90_000);
const MIN_VISIBLE_MS = Number(process.env.TEUM_CLI_MIN_VISIBLE_MS ?? 3_000);
const FETCH_TIMEOUT_MS = Number(process.env.TEUM_CLI_FETCH_TIMEOUT_MS ?? 1_200);
const PREV_TIMEOUT_MS = 900; // 기존(얹힌) 상태줄 명령 대기 한도 — 상태줄은 즉답이 생명
const CMD_TIMEOUT_MS = 8_000;
const ACCRUAL = process.env.TEUM_CLI_ACCRUAL !== '0';
const DEBUG = process.env.TEUM_CLI_DEBUG === '1';
/**
 * 광고 문구를 클릭 가능한 하이퍼링크로 만들지(OSC 8).
 * 'osc8'(기본) = iTerm2·kitty·WezTerm·Windows Terminal 등이 지원하는 표준 escape로 감싼다.
 * 'off' = 링크 없이 순수 텍스트(호스트가 escape를 통과시키지 않아 깨져 보이는 터미널의 탈출구).
 * 미지원 터미널은 보통 escape를 조용히 무시하지만, 호스트(상태줄 렌더러)가 문자를 이스케이프해
 * 그대로 보여줄 수도 있어 끌 수단을 남긴다.
 */
const LINK_MODE = process.env.TEUM_CLI_LINK ?? 'osc8';

const dir = join(homedir(), '.teum');
const cachePath = join(dir, 'cli.json');
const scriptPath = join(dir, 'statusline.mjs');
const settingsPath = join(homedir(), '.claude', 'settings.json');
/**
 * Gemini CLI(Antigravity) 설정. **키가 `statusLine`(camelCase)이어야 한다** — `statusline`이면
 * 조용히 무시된다. 우리 모델에 필요한 걸 이 호스트는 더 잘 준다: payload의 `agent_state`가
 * "지금 기다리는 중"을 직접 알려줘서 **Stop 훅이 필요 없다**(Claude Code에선 훅을 심어야 했다).
 * ⚠️ 대신 타이머 갱신이 없다 — 상태가 바뀔 때만 호출된다(표시시간은 상태 전이 간격으로 잰다).
 * ⚠️ 설정을 바꾸면 **CLI를 완전히 재시작**해야 반영된다.
 */
const geminiSettingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
/**
 * 런처 — settings.json이 가리키는 **실제 진입점**(node가 아니라 sh).
 * 왜 한 겹을 더 두는가: settings.json에 node 절대경로를 박으면 그 경로가 사라지는 순간
 * (nvm 버전 교체·`brew upgrade node`) 상태줄이 **아무 소리 없이** 죽고, 되살리는 코드도
 * node로 돌아가므로 스스로 복구할 수 없다. 런처는 sh라서 node가 없어도 실행되고,
 * 매 실행마다 node를 **다시 찾는다**.
 */
const launcherPath = join(dir, 'run.sh');
/** 설치 전 상태줄 명령(평문). node가 없을 때 런처가 이걸 대신 실행해 "설치 전과 같은 화면"을 만든다. */
const prevCmdPath = join(dir, 'prev-statusline');
/** 런처가 node를 못 찾았을 때 남기는 흔적(네트워크 호출 없음). 다음에 살아나면 1회 보고한다. */
const noNodePath = join(dir, 'nonode');

/** 홈 경로를 `~`로 줄여 보여준다. 설치 요약에 절대경로를 그대로 뿌리면 읽기 어렵다. */
function tildePath(p) {
  const h = homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
}
/**
 * "되돌리려면 뭘 치면 되나"를 유저가 방금 친 명령으로 답하기 위한 것.
 * 스크립트는 자기가 어떻게 불렸는지 모른다 — npm 패키지의 bin이 `TEUM_ENTRY`로 알려준다.
 * 알려주지 않았으면(에이전트가 직접 다운로드한 기존 경로) 예전처럼 파일 경로로 안내한다.
 */
function entryCommand() {
  const e = process.env.TEUM_ENTRY;
  if (typeof e === 'string' && /^[a-z0-9 @._/-]{1,40}$/i.test(e)) return e;
  return `node ${tildePath(scriptPath)}`;
}

const log = (...a) => { if (DEBUG) process.stderr.write('[teum] ' + a.join(' ') + '\n'); };
const KRW = (v) => '₩' + Number(v || 0).toLocaleString('ko-KR');

/**
 * 캐시 읽기 — **찢어진 읽기(torn read)를 새 지갑으로 오해하지 않는 것**이 핵심이다.
 *
 * 이 파일은 Claude Code 세션이 여러 개면 **동시에** 읽고 쓴다(refreshInterval마다). 종전엔
 * 쓰기가 비원자적이라 읽는 쪽이 잘린 JSON을 만날 수 있었고, 그때 `{}`를 돌려주면
 * `ensureDeviceId`가 **새 device를 발급 = 새 지갑 생성**이었다. 그 결과 정체성이 유실되고
 * IP당 지갑 상한이 소진돼 차단·알림 폭풍까지 이어졌다(2026-08-03 실사고).
 * 파일이 존재하는데 못 읽으면 **아무것도 하지 않는다**(이번 렌더 건너뜀). 새 정체성은
 * "파일이 정말 없을 때"만 만든다.
 */
function loadCache() {
  try { return JSON.parse(readFileSync(cachePath, 'utf8')); }
  catch {
    return existsSync(cachePath) ? { __unreadable: true } : {};
  }
}
/**
 * 원자적 쓰기(임시파일 → rename). 같은 디렉터리로 rename해야 원자성이 보장된다.
 *
 * ⚠️ **rename이 실패하면 임시 파일을 반드시 지운다**(2026-08-07, 윈도우 유저 제보).
 * 윈도우의 rename은 대상 파일을 다른 프로세스가 열고 있으면 EPERM/EBUSY로 실패한다.
 * 우리는 상태줄이 몇 초마다 돌고 세션이 여러 개일 수 있어 **정확히 그 상황을 상시로 만든다**
 * (백신 실시간 검사도 같은 잠금을 만든다). 종전엔 실패를 조용히 삼키기만 해서
 * `cache.json.<pid>.tmp`가 세션마다 하나씩 남았다. POSIX에선 rename이 덮어쓰므로 안 보였다.
 */
function atomicWrite(target, data, mode) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    // 권한은 **rename 전에** 임시파일에 건다(rename은 모드를 그대로 옮긴다).
    //  - mode를 준 경우: 그 값으로 강제(우리 파일 = 0600/0700).
    //  - 안 준 경우: 대상이 이미 있으면 **그 파일의 원래 권한을 보존**한다.
    //    남의 파일(settings.json)의 권한을 우리가 바꾸지 않기 위한 것.
    try {
      if (mode !== undefined) chmodSync(tmp, mode);
      else if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o777);
    } catch { /* 권한 설정 실패가 쓰기를 막을 이유는 없다 */ }
    renameSync(tmp, target);
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 무해 */ }
  }
}
function saveCache(c) {
  if (c?.__unreadable) return; // 못 읽은 상태로 덮어쓰면 남의 세션 상태를 날린다
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // ⚠️ 0600 필수 — 이 파일에는 deviceId와 살아있는 지갑 세션 토큰(door)이 들어 있다.
    // 즉 **읽을 수 있으면 지갑을 열 수 있다**. 종전엔 umask 기본값(0644)이라 같은 머신의
    // 다른 로컬 유저·홈을 훑는 동기화/백업 도구에 그대로 노출됐다(2026-08-14 발견).
    atomicWrite(cachePath, JSON.stringify(c), 0o600);
  } catch { /* 무해 */ }
}
/**
 * 이미 흩어진 찌꺼기 청소 — 위 수정 전 판이 남긴 `*.tmp`는 스스로 사라지지 않는다.
 * 우리 디렉터리 안에서, 우리 이름 규칙에 맞고, 한 시간 넘게 손대지 않은 것만 지운다.
 * 하루 한 번(자가 갱신 확인과 같은 리듬)만 돌아 렌더를 늦추지 않는다.
 */
function sweepTmp() {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.tmp')) continue;
      const p = join(dir, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > 3600_000) unlinkSync(p);
      } catch { /* 남이 쓰는 중이면 다음 기회에 */ }
    }
  } catch { /* 무해 */ }
}
/**
 * 테스트 모드 — `TEUM_CLI_TEST=1`이면 **격리된 정체성**으로 돈다.
 *
 * 서버는 device_id 접두가 `feedface`면 그 지갑을 자동으로 is_test로 표시한다. 이 스위치가
 * 없던 탓에 **우리가 CLI를 시험할 때마다 진짜 지갑이 태어났고**, 07-31~08-04에만 57개가
 * 쌓여 CLI 지면 지표(유저의 92%·노출의 69%)를 통째로 오염시켰다. 웰컴 보너스도 13건 나갔다.
 * 안전한 길이 없으면 사람은 위험한 길로 간다 — 그래서 길을 만든다.
 */
const TEST_MODE = process.env.TEUM_CLI_TEST === '1';
const TEST_PREFIX = 'feedface';

function ensureDeviceId(cache) {
  if (cache.__unreadable) return null; // 정체성 불명 — 이번 렌더는 네트워크를 건드리지 않는다
  // 테스트 모드에서 평소 정체성을 쓰면 오염이 그대로 재발한다 → 항상 격리 id로 갈아탄다.
  if (TEST_MODE) {
    if (!cache.deviceId || !String(cache.deviceId).toLowerCase().startsWith(TEST_PREFIX)) {
      cache.deviceId = `${TEST_PREFIX}-${randomUUID().slice(9)}`;
      saveCache(cache);
    }
    return cache.deviceId;
  }
  if (!cache.deviceId) {
    cache.deviceId = randomUUID();
    saveCache(cache);
  }
  return cache.deviceId;
}
/**
 * 이 statusLine 명령이 우리 것인가.
 * ⚠️ **런처(run.sh)도 반드시 포함**해야 한다. 빠뜨리면 setup이 우리 명령을 "남의 상태줄"로
 * 오해해 prevStatusLine에 저장하고, 런처가 그걸 다시 실행 = 무한 재귀가 된다.
 * (구판 = statusline.mjs 직접 호출, v8+ = run.sh. 둘 다 살아 있어야 이관 중에도 안전하다.)
 */
const isOurs = (cmd) =>
  typeof cmd === 'string' && /\.teum[/\\](statusline\.mjs|run\.sh)/.test(cmd);

// ── 상태줄 모드 — 기존 상태줄 위에 "얹기" ────────────────────────────────────
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const teal = (s) => `\x1b[36m${s}\x1b[0m`;
// 굵게. 리셋(\x1b[0m)이 아니라 22m(굵기만 해제)을 쓴다 — 호스트가 상태줄 전체에 입힌 스타일을
// 우리가 통째로 날려버리지 않기 위해서다.
const bold = (s) => `\x1b[1m${s}\x1b[22m`;

/**
 * 서버가 준 텍스트를 터미널에 그리기 전에 소독한다 — **제어문자를 전부 뺀다.**
 *
 * 2026-08-07 유저 제보("프롬프트 인젝션이 구조적으로 가능해 보인다")를 우리 코드로 확인하다
 * 찾은 실제 구멍이다. 상태줄은 Claude Code의 모델 컨텍스트로 들어가지 않으니 에이전트
 * 인젝션은 아니지만, **광고 문구는 서버(=DB=파트너 제출 소재)에서 오고 터미널로 그대로 나갔다.**
 * 거기에 ESC가 섞이면 커서 이동·화면 지우기·가짜 OSC 8 링크(보이는 글자와 다른 목적지)를
 * 만들 수 있다. 특히 우리는 바로 아래에서 OSC 8을 직접 쓰므로 `\x1b`·BEL 하나로 링크를
 * 조기 종료시켜 **우리 추적 URL 자리에 남의 URL을 끼워 넣는 것**이 가능했다.
 * 지금은 우리가 소재를 손으로 승인하지만, 방어를 승인 절차에 의존하지 않는다.
 */
function safeText(s, max = 120) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max);
}

/**
 * OSC 8 하이퍼링크로 감싼다: `ESC ] 8 ;; URL ST  텍스트  ESC ] 8 ;; ST`.
 * 링크는 우리 서버의 추적 URL(`/c?t=…`)을 가리킨다 — 터미널이 브라우저를 직접 열어버려
 * 스크립트가 클릭을 관측할 수 없으므로, 링크가 서버를 통과해야 집계된다(서버가 기록 후 광고주로 302).
 */
function link(text, url) {
  if (LINK_MODE !== 'osc8' || !url) return text;
  // URL도 소독한다. 지금 두 호출자 모두 우리 API 주소 + encodeURIComponent라 안전하지만,
  // **링크 목적지는 눈에 보이지 않는 자리**라 나중에 서버 값이 흘러들면 아무도 못 알아챈다.
  url = safeText(url, 512);
  if (!/^https?:\/\//.test(url)) return text;
  const ST = '\\';
  return `]8;;${url}${ST}${text}]8;;${ST}`;
}

/**
 * 광고 한 줄. **대기 중에만 그려지므로**(위 대기 감지) 흐리게 숨길 이유가 없다.
 * 오히려 상시 노출이던 시절의 dim 스타일이 "노출은 쌓이는데 아무도 안 보는" 상태를 만들었다.
 *
 * 위계: ⏰(우리 마크) · 광고·AD(고지 라벨, 작게) · **헤드라인(굵게)** · 업체명(틸).
 *
 * 마크가 ⏰인 이유(2026-07-31 결정): 우리가 돈으로 바꾸는 것은 커피가 아니라 **대기 시간**이다.
 * ⏰는 종 두 개 달린 둥근 알람시계라 **우리 마스코트의 형태 그 자체**여서, 설치 화면의
 * 픽셀 마스코트와 한 몸으로 읽힌다("작을 땐 ⏰, 클 땐 마스코트").
 * 커피(☕)는 버리지 않고 **보상 순간**(지갑·영수증·수령)으로 역할을 옮겼다.
 * 이모지는 자체 색을 가지므로 ANSI 색을 입히지 않는다.
 * 헤드라인을 굵게 하는 건 색이 아니라 굵기라서 밝은/어두운 테마 양쪽에서 안전하다
 * (밝은 흰색 등 특정 색을 쓰면 라이트 테마에서 사라진다).
 * 라벨은 링크 밖에 둬서 고지 기능을 유지한다(표시광고법).
 */
function renderAd(ad, doorUrl) {
  if (!ad?.headline) return '';
  const brand = ad.advertiserName ? ` ${dim('·')} ${teal(safeText(ad.advertiserName))}` : '';
  const body = link(`${bold(safeText(ad.headline))}${brand}`, ad.clickToken ? `${API}/c?t=${encodeURIComponent(ad.clickToken)}` : null);
  // ⏰는 **지갑으로 가는 문**이다. 유저에게 명령을 치라고 시키지 않으면서(비침투) 지갑에 닿는
  // 유일한 길 — 브라우저 툴바의 확장 아이콘이 그냥 거기 있는 것과 같은 성격이다.
  // 광고 문구는 광고주로, 우리 마크는 우리에게. 라벨(광고·AD)이 가운데서 둘을 가른다.
  return `${link('⏰', doorUrl)} ${dim('광고·AD')} ${body}`;
}

/** 얹기: 설치 전에 쓰던 상태줄 명령을 그대로 실행해 첫 줄을 가져온다(그들 것이 먼저, 우리는 뒤에). */
/**
 * ⚠️ **호스트별로 다른 상태줄을 보존한다.** 예전엔 `prevStatusLine` 하나뿐이라, 두 호스트에
 * 설치하면 Gemini CLI에서 **Claude Code의 상태줄 명령이 실행**됐다(다른 스키마의 stdin을 받고
 * 엉뚱한 줄을 그린다). 키를 호스트별로 나눈다 — 기존 설치는 `prevStatusLine`(claude)로 남아
 * 그대로 동작한다(하위호환).
 */
export const PREV_KEY = { claude: 'prevStatusLine', gemini: 'prevStatusLineGemini' };
function prevLine(cache, rawStdin, host = 'claude') {
  const prev = cache[PREV_KEY[host] ?? 'prevStatusLine']?.command;
  if (!prev || isOurs(prev)) return ''; // 자기 자신 재귀 가드
  try {
    const r = spawnSync(prev, { shell: true, input: rawStdin, timeout: PREV_TIMEOUT_MS, encoding: 'utf8' });
    return (r.stdout || '').split('\n')[0] ?? '';
  } catch { return ''; }
}

/**
 * 지갑 문 토큰 — 상태줄 ⏰에 걸 링크(마더 페이지 세션).
 *
 * ⚠️ 짧은 수명으로 받는다(기본 30분). 이 링크는 화면에 상시 떠 있어 터미널 녹화나 raw 라인
 * 복사로 샐 수 있는데, **미봉인 지갑은 토큰만으로 첫 봉인+수령이 가능**하도록 설계돼 있어
 * (첫 사용자 편의) 장수명 토큰을 박아두면 그 편의가 곧 구멍이 된다. 수명으로 위험을 자른다.
 * OSC 8 링크의 URL은 화면에 글자로 찍히지 않아 스크린샷으로는 새지 않는다.
 */
const DOOR_TTL_MIN = 30;
async function fetchDoor(cache) {
  try {
    const res = await fetch(`${API}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': cache.deviceId },
      body: JSON.stringify({ ttlMinutes: DOOR_TTL_MIN }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const d = await res.json();
    if (d?.token) {
      cache.door = d.token;
      cache.doorExp = Number(d.expiresAt) || Date.now() + DOOR_TTL_MIN * 60_000;
      log('door', new Date(cache.doorExp).toISOString());
    }
  } catch (e) { log('door-fail', e?.name ?? e); }
}
/** 남은 수명이 10분 미만이면 갱신 대상. 없으면 당연히 대상. */
const doorStale = (cache) => !cache.door || !(Number(cache.doorExp) > Date.now() + 10 * 60_000);
const doorUrlOf = (cache) => (cache.door ? `${API}/wallet?t=${encodeURIComponent(cache.door)}` : null);

/**
 * 서버 호출 실패 시 **물러서기(백오프)**.
 *
 * 왜 필수인가(2026-08-03 실제 사고): 지갑 생성이 차단되면(429) 서버는 그 디바이스를 `devices`에
 * 기록하지 않는다 — 가드가 생성 *직전*에 막기 때문이다. 그래서 다음 요청도 똑같이 콜드 패스를 타고
 * 똑같이 막힌다. 그런데 종전 fetchAd는 `res.ok`일 때만 캐시를 갱신해서, 실패하면 `fetchedAt`이
 * 영원히 비고 → **매 렌더마다 재시도** → refreshInterval(3초) × 여러 세션 = 분당 100건 이상,
 * 시간당 7,563건이 서버에 꽂혔다. 스스로 멈추지 않는 루프였다.
 *
 * 공유 IP(사무실·학교)에서 상한에 걸린 **정상 유저**에게도 똑같이 일어나므로, 이건 어뷰징 대응이
 * 아니라 **기본 예의**다. 서버가 Retry-After를 주면 그걸 따르고, 없으면 지수적으로 늘린다.
 */
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];
const inBackoff = (cache) => Number(cache.backoffUntil ?? 0) > Date.now();
function noteFailure(cache, retryAfterSec) {
  const n = Math.min((Number(cache.failStreak ?? 0)) + 1, BACKOFF_STEPS_MS.length);
  cache.failStreak = n;
  const byStreak = BACKOFF_STEPS_MS[n - 1];
  // 서버가 알려준 값이 있으면 존중하되, 무한정 잠들지 않게 1시간으로 자른다.
  const hinted = Number(retryAfterSec) > 0 ? Math.min(Number(retryAfterSec) * 1000, 60 * 60_000) : 0;
  cache.backoffUntil = Date.now() + Math.max(byStreak, hinted);
  log('backoff', `streak=${n}`, `until=${new Date(cache.backoffUntil).toISOString()}`);
}
const noteSuccess = (cache) => { cache.failStreak = 0; cache.backoffUntil = 0; };

/** 호스트 → 서버 site 태그. 서버의 `CLI_SITES`와 짝이다(여기 없는 값을 보내면 확장으로 태깅된다). */
const SITE_OF = { claude: 'claudecode', gemini: 'geminicli' };

async function fetchAd(cache, host = 'claude') {
  const site = SITE_OF[host] ?? 'claudecode';
  try {
    const res = await fetch(`${API}/v1/ads/serve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': cache.deviceId },
      body: JSON.stringify({ site }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      noteSuccess(cache);
      const ad = await res.json();
      if (ad?.headline) {
        // 새 광고 = 새 노출 단위. firstShownAt은 실제로 그려질 때 찍고(대기 중에만 그린다),
        // waitMs(누적 대기 시간)는 0으로 리셋한다.
        // ⚠️ **가져올 때의 site를 함께 굳힌다.** `revenueKrw`가 site별 단가(SURFACE_RATE)로 계산돼
        // 노출 서명에 들어가므로, 보고할 때 다른 site를 보내면 서버가 재계산에 실패해 **서명
        // 불일치로 거부**한다. 두 CLI가 한 캐시를 공유하므로 실제로 어긋날 수 있는 경로다.
        cache.adSite = site;
        cache.ad = ad; cache.fetchedAt = Date.now(); cache.firstShownAt = null; cache.reported = false; cache.waitMs = 0;
        log('served', ad.adId, ad.headline);
      }
    } else {
      // 429(지갑 생성 상한·레이트리밋)를 포함한 모든 비정상 응답에서 물러선다.
      const hint = Number(res.headers.get('retry-after'))
        || await res.json().then((b) => Number(b?.retryAfterSec)).catch(() => 0);
      noteFailure(cache, hint);
    }
  } catch (e) { noteFailure(cache); log('serve-fail', e?.name ?? e); }
}

/**
 * 자가 갱신 — 이게 없으면 우리가 서버 파일을 고쳐도 **이미 설치된 유저에겐 영원히 안 간다**
 * (스크립트는 ~/.teum의 로컬 파일이다). 2026-08-03 사고에서 옛 판을 도는 기기가 계속
 * 서버를 두드린 것도 같은 이유였다.
 *
 * 위험 방향이 반대라는 점이 설계를 결정한다: 갱신이 안 되면 한 사람이 옛 판에 머물지만,
 * **깨진 판을 받으면 전원이 동시에 죽는다**. 그래서 갈아타기 전에 세 겹으로 확인한다.
 *   ① 우리 스크립트의 표식이 있는가(HTML 오류 페이지·잘린 응답 차단)
 *   ② `node --check`로 문법이 성립하는가(우리가 깨진 판을 올린 경우의 최후 방어)
 *   ③ 임시 파일에 받아 검사 후 rename(원자적 교체 — 반쪽 파일이 남지 않는다)
 * 실패해도 하루에 한 번만 시도한다(실패 폭주 금지 — 08-03의 교훈).
 */
/**
 * 받은 판이 **우리 릴리즈 키로 서명된 것인지** 확인한다. 실패는 전부 false(예외를 밖으로
 * 흘리지 않는다 — 갱신 실패는 조용해야 하고, 조용히 실패하면 현 판에 머물 뿐이다).
 */
/**
 * 판번호는 숫자 문자열이다('4','5',…). **오직 더 높은 판으로만** 간다.
 * 숫자로 못 읽히면(형식 변경·응답 오염) 갱신하지 않는다 = 안전한 실패.
 */
/**
 * 되돌리기 차단 — 받은 본문이 스스로 밝히는 판이 지금보다 **높을 때만** 설치한다.
 *
 * ⚠️ 이 규칙의 대가(2026-08-21에 실제로 당함): **같은 번호로 두 번 배포하면 그 판에 갇힌다.**
 * 08-20에 v10을 세 번 배포했는데(cf9fde3c → dc4b4807 → 6e5eee80) 이미 v10을 받은 기기는
 * `10 > 10`이 거짓이라 **자가 갱신이 영원히 안 왔다.** 광고가 안 사라지는 버그를 고쳐 놓고도
 * 그 수정이 유저에게 갈 길이 막혀 있었다.
 * ⇒ **스크립트를 고쳐 배포할 때마다 VERSION을 올린다.** 예외 없다.
 *    (`npm run release:cli`가 안 올리면 배포를 막는다.)
 */
function isNewerVersion(candidate) {
  const a = Number(candidate);
  const b = Number(VERSION);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

function verifyRelease(body, sigB64) {
  try {
    return verifySignature(null, Buffer.from(body, 'utf8'), createPublicKey(RELEASE_PUBKEY), Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

const UPDATE_CHECK_MS = Number(process.env.TEUM_CLI_UPDATE_MS ?? 24 * 3600_000);
/**
 * 자가 갱신 끄기 — `TEUM_CLI_NO_UPDATE=1`.
 *
 * 자가 갱신은 구조적으로 **우리 서버가 유저 기기에서 코드를 실행시키는 것**이다. 위 세 겹은
 * *깨진* 판을 막지 그 성질 자체를 없애지 못한다. 그러니 최소한 **끌 수 있어야 하고, 껐을 때
 * 아무것도 고장 나지 않아야 한다**(끄면 그냥 이 판에 머문다). 2026-08-07 유저 제보로 추가.
 */
const UPDATE_DISABLED = process.env.TEUM_CLI_NO_UPDATE === '1';
const updateDue = (cache) =>
  !UPDATE_DISABLED && (!cache.updateCheckedAt || Date.now() - cache.updateCheckedAt > UPDATE_CHECK_MS);

async function selfUpdate(cache) {
  cache.updateCheckedAt = Date.now(); // 성공·실패와 무관하게 먼저 찍는다
  try {
    const res = await fetch(`${API}/cli/version`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return;
    const latest = String((await res.json().catch(() => ({})))?.version ?? '');
    if (!isNewerVersion(latest)) return;

    const r2 = await fetch(`${API}/cli/statusline.mjs`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 8) });
    if (!r2.ok) return;
    const body = await r2.text();
    if (body.length < 15_000 || !body.includes('const VERSION =') || !body.includes('function renderAd(')) return;

    // ⑤ **되돌리기(다운그레이드) 차단** — 서명만으로는 못 막는 공격이 하나 남는다:
    //    공격자가 **예전 판 + 그 판의 정품 서명**을 그대로 재생하는 것. 옛 판에는 지금의 방어가
    //    없으므로(서명 검증 자체가 v5부터다) 한 번 되돌리면 그 뒤로는 아무 코드나 밀어넣을 수 있다.
    //    ⇒ **받은 코드가 스스로 밝히는 판번호**가 지금보다 높을 때만 설치한다.
    //    서버 응답(`/cli/version`)이 아니라 **본문**을 믿는 것이 요점이다. 서버는 "6"이라고
    //    말하면서 서명된 옛 본문을 줄 수 있다. (2026-08-07 E2E에서 실제로 뚫렸던 경로)
    const bodyVersion = /const VERSION = '([^']+)'/.exec(body)?.[1];
    if (!isNewerVersion(bodyVersion)) { log('update-refused', 'downgrade', bodyVersion); return; }

    // ④ **서명 검증** — 위 세 겹은 *깨진* 판을 막을 뿐 *다른 사람이 보낸* 판을 못 막는다.
    // 서명이 없거나 맞지 않으면 갱신하지 않는다(현 판에 그대로 머문다 = 안전한 실패).
    const sigRes = await fetch(`${API}/cli/statusline.mjs.sig`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 4) })
      .catch(() => null);
    const sig = sigRes?.ok ? (await sigRes.text().catch(() => '')).trim() : '';
    if (!sig || !verifyRelease(body, sig)) {
      log('update-refused', 'bad-signature', latest);
      cache.updateRefusedAt = Date.now();
      return;
    }

    // ⚠️ 임시 파일도 반드시 .mjs로 끝나야 한다. 확장자가 다르면 `node --check`가 CommonJS로
    //    파싱해 ESM import를 문법 오류로 보고, **정상 판까지 거부해 갱신이 영영 멈춘다**.
    const tmp = `${scriptPath}.${process.pid}.new.mjs`;
    try {
      writeFileSync(tmp, body);
      const chk = spawnSync(process.execPath, ['--check', tmp], { timeout: 5_000 });
      if (chk.status !== 0) return;
      renameSync(tmp, scriptPath);
    } finally {
      // rename이 실패해도(윈도우 잠금) 반쪽 파일을 남기지 않는다.
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 무해 */ }
    }
    // 갱신을 **말한다**. 조용한 자동 갱신은 그 자체로 신뢰 문제다(2026-08-07 유저 제보).
    cache.updateNotice = { from: VERSION, to: latest };
    log('self-update', VERSION, '→', latest);
  } catch (e) { log('update-fail', e?.name ?? e); }
}

/**
 * 하루 한 번 도는 정비 묶음 — 자가 갱신 · 임시파일 청소 · 권한 조이기 · 명령 교정 · node 부재 보고.
 *
 * **한 벌로 둔다.** 렌더 경로와 Stop 훅 두 곳에서 부르는데, 각자 나열하면 한쪽만 고쳐지는 날이
 * 오고 그 대상이 "유저에게 수정을 보내는 유일한 통로"다(`mergeWallets`를 하나로 묶은 것과 같은 이유).
 */
async function dailyMaintenance(cache) {
  await selfUpdate(cache); sweepTmp();
  hardenPerms(); ensureCommands(cache); await reportNoNodeIfSeen(cache);
}

/**
 * 정비를 **떼어낸 자식**에게 던지고 즉시 돌아온다. Stop 훅에서만 쓴다.
 *
 * 왜 기다리지 않나(원칙 6 — 실패 경로의 대기시간은 곱해진다): `selfUpdate`는 네트워크 3건이고
 * 타임아웃 합이 1.2 + 9.6 + 4.8 = **최악 15.6초**, 여기에 `node --check`(5초)까지 붙는다.
 * 훅이 이걸 기다리면 **유저 눈에는 응답이 끝나고도 20초를 더 붙잡는 것**으로 보인다.
 * 갱신은 급할 게 없으므로 던져 놓고 다음 실행에서 결과를 쓰면 된다.
 */
function spawnDetachedMaintenance() {
  try {
    // ⚠️ **지금 돌고 있는 이 파일**을 띄운다(`scriptPath`가 아니라). 둘은 대개 같지만,
    //    npx로 실행되는 경우처럼 설치본이 아직 없을 수도 있다. 없는 경로를 띄우면 자식이
    //    조용히 죽고 **갱신 통로가 열린 척만 한다** — 검증에서 실제로 이렇게 잡혔다.
    spawn(process.execPath, [process.argv[1] || scriptPath, 'update'], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 못 띄워도 훅은 정상 종료한다 — 갱신은 다음 기회에 */ }
}

/** 정비 전용 실행 — 화면에 아무것도 쓰지 않는다(자식으로 도는 데다 훅 stdout은 계약이 따로 있다). */
async function cmdUpdate() {
  const cache = loadCache();
  if (cache.__unreadable) return; // 찢어진 읽기로 캐시를 덮어쓰지 않는다
  await dailyMaintenance(cache);
  saveCache(cache);
}

/*
 * v7의 `migrateStopHook`(구판 훅 이관)과 `repairNodePath`(죽은 node 경로 갈아끼우기)는
 * v8에서 `ensureCommands`로 합쳤다. 셋이 각자 명령 문자열을 쓰고 있었고, 그중 둘은
 * **검증 없이** 새 명령을 심어서 fail-open이었다(로컬 검증에서 실제로 잡혔다).
 * 특히 구판 훅은 `date > stop.at` 셸 한 줄이라 node 없이도 도는데, 그걸 검증 없이
 * node 의존 명령으로 바꾸면 우리가 고치려던 고장을 우리 손으로 만든다.
 * 이제 명령을 정하는 곳은 `pickCommands` 하나이고, 심기 전에 반드시 실제로 돌려본다.
 */

async function reportImpression(cache) {
  const ad = cache.ad;
  if (!ad?.nonce || !ad?.signature) return;
  // visibleMs = **기다리는 동안 광고가 떠 있던 시간**(누적 대기). 벽시계 캐시 나이가 아니다.
  // 서버가 servedAt 경과시간으로 상한을 재강제하므로 과대보고는 어차피 깎인다.
  const visibleMs = Math.round(Number(cache.waitMs ?? 0));
  try {
    const res = await fetch(`${API}/v1/impressions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': cache.deviceId },
      body: JSON.stringify({
        adId: ad.adId, site: cache.adSite ?? 'claudecode', shownAt: cache.firstShownAt, visibleMs,
        nonce: ad.nonce, servedAt: ad.servedAt, signature: ad.signature, categoryHint: null,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      cache.reported = true;
      const r = await res.json().catch(() => ({}));
      // 깜짝 보너스는 서버가 이 응답에만 담아준다(유저당 1회). 여기서 안 주우면 영영 모른다.
      // 말하는 건 턴이 끝날 때(Stop 훅) — 기다리는 중에 끼어들지 않는다.
      if (Number(r?.surpriseKrw) > 0) cache.notice = { krw: Number(r.surpriseKrw), at: Date.now() };
      log('reported', ad.adId, `visibleMs=${visibleMs}`, r?.result ?? '');
    }
  } catch (e) { log('report-fail', e?.name ?? e); }
}

/**
 * 진단 추적(TEUM_CLI_TRACE=1) — **대기 감지 설계를 위한 실측 도구.**
 *
 * 지금 상태줄은 호출될 때마다 광고를 그린다 = 대기 중이 아닐 때도 상시 노출된다.
 * 이는 절대원칙 #4("대기가 끝나면 광고를 종료")와 어긋나고, 노출·표시시간 집계도
 * "기다리지 않은 시간"을 포함해 광고주에게 파는 숫자를 흐린다.
 *
 * 대기 시점을 알아내는 두 후보를 추측 없이 확인하려고 남긴다:
 *   ① 호스트가 stdin으로 주는 세션 JSON에 작업 상태 필드가 있는가
 *   ② 없더라도 **호출 간격**이 생각 중 vs 유휴에서 다른가(다르면 그것이 신호)
 *
 * 켜는 법: `touch ~/.teum/trace.on` (또는 TEUM_CLI_TRACE=1).
 * **파일 플래그를 우선 지원하는 이유**: 상태줄은 호스트(Claude Code)가 실행될 때의 환경변수를
 * 물려받으므로, 이미 켜져 있는 세션에서는 env로 켤 수 없다(재시작 강요). 파일이면 다른 셸에서
 * 한 번 touch하면 다음 렌더부터 즉시 적용된다.
 *
 * ⚠️ 파일은 로컬(~/.teum/trace.jsonl)에만 남고 **서버로 전송하지 않는다**(절대원칙 #2).
 * 최대 400줄에서 멈춘다(무한 증가 방지). 진단이 끝나면 두 파일을 지우면 된다.
 */
function traceOn() {
  if (process.env.TEUM_CLI_TRACE === '1') return true;
  try { return existsSync(join(dir, 'trace.on')); } catch { return false; }
}

function trace(rawStdin, rendered) {
  if (!traceOn()) return;
  try {
    const path = join(dir, 'trace.jsonl');
    let lines = 0;
    try { lines = readFileSync(path, 'utf8').split('\n').length; } catch { /* 첫 줄 */ }
    if (lines > 400) return;
    mkdirSync(dir, { recursive: true });
    const rec = JSON.stringify({ t: Date.now(), rendered, stdinLen: rawStdin.length, stdin: rawStdin.slice(0, 4000) });
    writeFileSync(path, rec + '\n', { flag: 'a' });
  } catch { /* 진단 실패가 상태줄을 막지 않는다 */ }
}

/**
 * 대기 감지 — "광고는 기다리는 동안에만"(절대원칙 #4)의 CLI 구현.
 *
 * 호스트는 "지금 생성 중" 같은 플래그를 주지 않는다. 대신 렌더마다 넘어오는 세션 JSON의
 * **누적값 변화**와 **호출 자체의 리듬**으로 판정한다(실측 근거는 아래).
 *
 *  - `prompt_id` 변경   = 새 프롬프트가 방금 제출됐다 → **대기 시작**(아직 api 시간은 0이므로
 *                        이 신호가 없으면 대기 시작 순간에 광고를 숨기는 반대 실수를 한다).
 *  - **종료 마커**(~/.teum/stop.at) = 호스트의 Stop 훅이 찍는 "응답 끝" 시각 → **대기 종료**.
 *                        이게 있으면 도구 실행처럼 api 시간이 안 늘어나는 구간도 정확히 대기로 유지된다.
 *  - `Δcost.total_api_duration_ms > 0` = 직전 구간에 모델이 실제로 생성했다 → 대기 구간이었다.
 *  - 짧은 렌더 간격      = (종료 마커가 없는 설치의 폴백) 에이전트 루프가 도는 중.
 *                        ⚠️ `statusLine.refreshInterval`이 켜져 있으면 간격이 항상 짧아 이 신호는
 *                        무의미해진다 → 마커가 있으면 간격 휴리스틱을 쓰지 않는다.
 *
 * 실측(2026-07-30, 창업자 머신): 렌더는 **스트리밍이 아니라 이벤트 기반**이다.
 *   · 도구를 쓰는 세션: 1.7~1.9초 간격으로 자주 렌더, 유휴가 되면 18~22초로 벌어진다.
 *   · 도구 없는 순수 생성: **렌더 1회뿐**(그 뒤 4분 반 동안 재호출 없음).
 * ⇒ 대기 시작에는 호출되지만 **순수 생성의 종료 시점에는 호출되지 않는다.** 그래서 이벤트만으로는
 *    광고 픽셀을 제때 지울 수 없었다. 해법은 호스트 설정 두 개다(setup이 함께 심는다):
 *      · `statusLine.refreshInterval` — 주기적으로 재실행 = **지울 기회**를 만든다.
 *      · `Stop` 훅 — 응답이 끝난 시각을 파일로 남긴다 = **지울 시점**을 알려준다.
 *    둘이 있으면 브라우저와 같은 생명주기(대기 시작에 등장, 종료 즉시 소멸)가 된다.
 */
const ACTIVE_GAP_MS = Number(process.env.TEUM_CLI_ACTIVE_GAP_MS ?? 8_000);
/**
 * 턴이 열린 뒤 이만큼 모델 활동(api 시간 증가)이 없으면 끝난 것으로 본다.
 * Stop 훅이 없거나 낡았을 때의 안전망. 도구가 오래 도는 구간(api 시간 미증가)을 감안해 넉넉히 잡되,
 * 넘어가면 숨기는 쪽으로 판단한다(모르면 안 보여주는 게 우리 원칙에 맞다).
 */
const TURN_MAX_IDLE_MS = Number(process.env.TEUM_CLI_TURN_MAX_IDLE_MS ?? 180_000);

/**
 * 호스트 Stop 훅이 남긴 "응답 끝" 표식. 없으면 null(=훅 미설치 → 폴백 경로).
 *
 * ⚠️ **시각만으로는 부족하다**(2026-08-20 창업자 실사용 제보로 드러남). 응답이 빠르면
 * (실측 1,962ms) Stop 훅이 상태줄의 **첫 렌더보다 먼저** 도착한다. 그러면 렌더가 그 prompt를
 * 처음 보면서 `startedAt = now`를 찍는데 그 값이 종료 시각보다 **나중**이라, 이미 끝난 턴이
 * "열린 것"으로 판정돼 광고가 떴다. 그리고 호스트가 렌더를 멈추면 그 프레임이 화면에 굳는다.
 *
 * ⇒ 마커에 **어느 턴이 끝났는지**(prompt_id·session_id)를 함께 적는다. 그러면 타이밍 비교가
 *   필요 없어진다 — 지금 보고 있는 prompt가 곧 끝난 그 prompt면 턴은 끝난 것이다.
 *
 * 형식 셋을 다 읽는다(구판 호환): 초(구 셸 훅) · 밀리초 · JSON{at,promptId,sessionId}.
 */
function readStopMarker() {
  try {
    const raw = readFileSync(join(dir, 'stop.at'), 'utf8').trim();
    if (raw.startsWith('{')) {
      const o = JSON.parse(raw);
      const at = Number(o?.at);
      if (!Number.isFinite(at) || at <= 0) return null;
      return {
        at,
        promptId: typeof o?.promptId === 'string' ? o.promptId : null,
        sessionId: typeof o?.sessionId === 'string' ? o.sessionId : null,
      };
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return null;
    // 값이 1e12보다 크면 밀리초, 작으면 초(구 훅). 초 단위는 그 **초의 끝(+999ms)**으로 본다 —
    // 안 그러면 같은 초에 시작된 턴이 "정지보다 나중"으로 보여 광고가 안 사라진다.
    return { at: v > 1e12 ? v : v * 1000 + 999, promptId: null, sessionId: null };
  } catch {
    return null;
  }
}

/**
 * Gemini CLI(Antigravity)에서 "지금 기다리는 중"으로 보는 상태.
 * payload의 `agent_state`: idle · thinking · working · tool_use · initializing.
 * `initializing`은 기동 중이라 대기가 아니고, `idle`은 응답이 끝난 상태다.
 */
const GEMINI_BUSY = new Set(['thinking', 'working', 'tool_use']);

function parseHostState(rawStdin) {
  try {
    const d = JSON.parse(rawStdin);
    // 🖥️ 호스트 판별 — **payload가 스스로 밝힌다.** 설정 플래그를 따로 두지 않는다(설치 경로가
    // 어긋나도 안 깨진다). Gemini CLI만 `agent_state`를 싣는다.
    const agentState = typeof d?.agent_state === 'string' ? d.agent_state : null;
    return {
      apiMs: Number(d?.cost?.total_api_duration_ms ?? NaN),
      promptId: typeof d?.prompt_id === 'string' ? d.prompt_id : null,
      // Gemini는 session_id가 없을 수 있다 → workspace로 세션 버킷을 가른다(여러 창 구분).
      sessionId: typeof d?.session_id === 'string' ? d.session_id
        : (agentState && typeof d?.workspace === 'string' ? `ws:${d.workspace}` : null),
      agentState,
      host: agentState ? 'gemini' : 'claude',
    };
  } catch {
    return { apiMs: NaN, promptId: null, sessionId: null, agentState: null, host: 'claude' };
  }
}

/**
 * 턴 상태는 **세션별로** 보관한다.
 *
 * 왜: Claude Code 세션이 여러 개면 모두 같은 캐시 파일을 쓴다. 종전엔 `lastPromptId`를 하나만
 * 두어서, 세션 A가 렌더할 때 캐시엔 세션 B의 prompt_id가 들어 있었다 → 매 렌더가 "새 프롬프트"로
 * 판정 → 턴이 계속 새로 열려 **광고가 유휴에도 사라지지 않았다**(2026-08-03 창업자 관측:
 * prompt_id가 두 값 사이를 5초마다 왕복). 대기 감지의 전제가 "세션 하나"였던 게 잘못이다.
 * 세션 id가 없으면(직접 실행 등) 단일 버킷으로 떨어진다.
 */
function turnStateOf(cache, sessionId) {
  const key = sessionId || '_';
  cache.sessions = cache.sessions && typeof cache.sessions === 'object' ? cache.sessions : {};
  // 오래된 세션 정리(하루 넘게 안 보인 것) — 파일이 무한히 자라지 않게.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(cache.sessions)) {
    if (k !== key && Number(v?.seenAt ?? 0) < cutoff) delete cache.sessions[k];
  }
  if (!cache.sessions[key]) cache.sessions[key] = {};
  return cache.sessions[key];
}

async function statusline() {
  let rawStdin = '';
  try { rawStdin = readFileSync(0, 'utf8'); } catch { /* stdin 없이 직접 실행 */ }

  const cache = loadCache();
  // 캐시를 못 읽었으면(동시 쓰기와 겹친 찢어진 읽기) **아무것도 하지 않고 조용히 빠진다**.
  // 새 정체성을 만들지도, 남의 세션 상태를 덮어쓰지도 않는다. 다음 렌더(3초 뒤)에 정상화된다.
  // 기존 상태줄은 계속 보여야 하므로 그것만 출력한다.
  if (!ensureDeviceId(cache)) {
    process.stdout.write(prevLine(cache, rawStdin));
    return;
  }

  const now = Date.now();
  const st = parseHostState(rawStdin);
  const turn = turnStateOf(cache, st.sessionId); // ⚠️ 세션별 상태(여러 세션이 한 파일을 공유한다)
  turn.seenAt = now;
  const gap = turn.lastRenderAt ? now - turn.lastRenderAt : Infinity;
  const dApi = Number.isFinite(st.apiMs) && Number.isFinite(turn.lastApiMs) ? st.apiMs - turn.lastApiMs : 0;
  const newPrompt = Boolean(st.promptId) && st.promptId !== turn.lastPromptId;
  // 호스트 상태를 못 읽으면(직접 실행·스키마 변경) 종전처럼 표시한다 = 조용한 무광고 회귀 방지.
  const isGemini = st.host === 'gemini';
  // Gemini는 상태를 직접 알려주므로 아래 휴리스틱 탑(프롬프트·Δapi·마커·유휴안전망)이 필요 없다.
  const blind = !isGemini && !Number.isFinite(st.apiMs) && !st.promptId;

  // 턴 상태: 프롬프트 제출로 열리고, Stop 훅이 찍은 종료 시각으로 닫힌다.
  if (newPrompt) turn.startedAt = now;
  // 모델이 실제로 일한 마지막 시각(생성이 있었던 렌더). 대기 여부의 1차 근거.
  if (newPrompt || dApi > 0) turn.lastApiAt = now;
  const stopMark = readStopMarker();
  const stoppedAt = stopMark ? stopMark.at : null;
  const hasStopSignal = stopMark !== null;
  /* ⭐ 정체로 판정한다(2026-08-20). 마커가 "이 prompt가 끝났다"고 말하면 시각 비교가 필요 없다.
     시각만 보면 **빠른 응답에서 Stop이 첫 렌더보다 먼저 도착**해 이미 끝난 턴을 열게 된다
     (실측: 응답 1,962ms → stop 14:27:57 → 첫 렌더 14:27:58 → "시작 > 종료" → 광고 표시).
     구판 마커(시각만)면 promptId가 없으므로 false가 되어 종전 경로로 떨어진다. */
  const stoppedThisPrompt = Boolean(stopMark?.promptId && st.promptId && stopMark.promptId === st.promptId);
  // ⚠️ **Stop 훅에만 의존하지 않는다.** 훅은 세션이 시작될 때 로드되므로 훅을 추가하기 전에
  // 시작된 세션에서는 아예 돌지 않고, 마커도 전역 하나라 어느 세션이 끝났는지 구분하지 못한다
  // (2026-08-03 실측: 마커가 11분째 낡은 채로 남아 광고가 계속 떠 있었다).
  // 그래서 "마지막으로 모델이 일한 뒤 TURN_MAX_IDLE_MS가 지나면 턴은 끝난 것"으로 본다.
  // 보수적인 방향(모르면 숨김)이라 절대원칙("대기 중에만")과도 맞다.
  const idleTooLong = now - Number(turn.lastApiAt ?? turn.startedAt ?? 0) > TURN_MAX_IDLE_MS;
  // ⭐ 끝난 prompt를 지금 보고 있으면 시각과 무관하게 턴은 끝난 것이다(위 stoppedThisPrompt 주석).
  const turnActive = Boolean(turn.startedAt) && !stoppedThisPrompt
    && (!hasStopSignal || turn.startedAt > stoppedAt);

  // 마커가 있으면 그것이 권위(간격 휴리스틱은 refreshInterval 때문에 무의미해진다).
  // 없으면 종전 폴백(간격)으로 동작 — 훅을 심지 않은 기존 설치 호환.
  // 판정 구조:
  //  ① 방금 일이 있었나(새 프롬프트·모델 생성) → 무조건 대기
  //  ② 아니면 턴이 아직 열려 있나(마커가 있으면 마커 기준, 없으면 렌더 간격 폴백)
  //  ③ 단, ②는 **유휴 안전망(idleTooLong)에 무조건 걸린다** — 마커가 낡거나 없어도 턴은 닫힌다.
  const recentWork = newPrompt || dApi > 0;
  const stillInTurn = hasStopSignal ? turnActive : gap < ACTIVE_GAP_MS;
  /**
   * 🖥️ Gemini CLI: `agent_state`가 곧 답이다. Claude Code에선 종료 시점을 몰라 Stop 훅과
   * 유휴 안전망까지 쌓아야 했는데(그 탑이 위 20여 줄이다), 여기선 호스트가 직접 말해준다.
   * ⇒ 대기 판정이 추정이 아니라 **사실**이 된다.
   */
  const inWait = isGemini ? GEMINI_BUSY.has(st.agentState) : (blind || recentWork || (stillInTurn && !idleTooLong));

  // 이번 구간이 대기였다면 **실제 대기 시간만** 누적한다(광고가 화면에 떠 있던 벽시계 시간이 아니라).
  // 이 값이 노출 보고의 visibleMs가 된다 → 리포트의 "평균 표시 시간"이 "기다리는 동안 떠 있던 시간"이 된다.
  // ⚠️ 상한은 항상 **벽시계 간격(gap)**이다. Δapi는 병렬 API 호출 때문에 실제 경과 시간보다
  // 빠르게 늘 수 있어(실측: 1.9초 사이에 Δapi 9.5초) 그대로 쓰면 과대보고가 되고, 서버가
  // servedAt 경과 상한으로 깎다가 최소시간 미달로 **정당한 노출까지 무효**가 된다.
  //   · Δapi>0        → 그 구간은 생성이 있었으니 구간 전체를 대기로 인정(=gap)
  //   · 그 외 대기판정 → 촘촘한 렌더(에이전트 루프)라 gap을 인정하되 ACTIVE_GAP_MS로 절단
  if (isGemini) {
    /**
     * Gemini는 **상태가 바뀔 때만** 호출된다(타이머 갱신이 없다). 그래서 이번 호출까지의 간격
     * `gap`이 곧 **직전 상태가 지속된 시간**이다 — 직전이 대기였다면 그 시간만큼 광고가 실제로
     * 떠 있었다. 표본이 아니라 실측이라 Claude Code 쪽의 절단(ACTIVE_GAP_MS)이 필요 없다.
     * ⚠️ 그래서 판단 기준은 `inWait`(지금)이 아니라 `turn.wasBusy`(직전)다.
     */
    if (cache.ad && turn.wasBusy && Number.isFinite(gap)) {
      cache.waitMs = Math.max(0, Number(cache.waitMs ?? 0)) + Math.max(0, gap);
    }
    turn.wasBusy = inWait;
  } else if (cache.ad && inWait && !newPrompt && Number.isFinite(gap)) {
    const add = dApi > 0 ? gap : Math.min(gap, ACTIVE_GAP_MS);
    cache.waitMs = Math.max(0, Number(cache.waitMs ?? 0)) + Math.max(0, add);
  }

  // 1) 즉답: 기존 상태줄(있으면) + (대기 중일 때만) 광고를 합쳐 먼저 그린다.
  const theirs = prevLine(cache, rawStdin, st.host);
  let ours = '';
  if (cache.ad?.headline && inWait) {
    if (!cache.firstShownAt) cache.firstShownAt = now;
    ours = renderAd(cache.ad, doorUrlOf(cache));
  }
  process.stdout.write(theirs && ours ? `${theirs}  ${ours}` : theirs || ours);
  trace(rawStdin, Boolean(ours));

  turn.lastRenderAt = now;
  if (Number.isFinite(st.apiMs)) turn.lastApiMs = st.apiMs;
  if (st.promptId) turn.lastPromptId = st.promptId;

  // 2) 호출당 네트워크 최대 1건. 광고 교체는 대기 중에만(유휴에 새 광고를 미리 태우지 않는다).
  // ⚠️ **다른 호스트가 받아온 광고는 쓰지 않는다.** 두 CLI가 한 캐시 파일을 공유하므로, 그냥
  // 쓰면 Gemini 화면에 뜬 노출이 `claudecode`로 기록돼 지면 측정이 오염되고 단가(SURFACE_RATE)도
  // 어긋난다. site가 다르면 낡은 것으로 보고 그 호스트 몫으로 다시 받는다.
  const sameSite = (cache.adSite ?? 'claudecode') === (SITE_OF[st.host] ?? 'claudecode');
  const fresh = cache.fetchedAt && now - cache.fetchedAt < CACHE_TTL_MS && sameSite;
  if (inBackoff(cache)) { /* 물러서는 중 — 이번 렌더는 네트워크를 건드리지 않는다 */ }
  else if (!fresh && inWait) await fetchAd(cache, st.host);
  else if (ACCRUAL && cache.ad && !cache.reported && Number(cache.waitMs ?? 0) >= MIN_VISIBLE_MS) {
    await reportImpression(cache);
  } else if (inWait && doorStale(cache)) {
    // 광고·노출보고가 없을 때만 문 토큰을 갱신 = **호출당 네트워크 최대 1건** 규칙 유지.
    // 30분 수명에 10분 여유라 실제 발급은 20분에 한 번꼴이다.
    await fetchDoor(cache);
  }
  // 자가 갱신은 위 사슬 **밖**에 둔다. 안에 넣으면 활성 유저는 늘 광고·보고에 밀려
  // 영영 순번이 오지 않는다(=갱신이 안 되는 게 기본값이 된다). 하루 한 번이고, 상태줄은
  // 이미 위에서 출력을 끝냈으므로 이 호출이 화면을 늦추지 않는다.
  if (updateDue(cache)) await dailyMaintenance(cache);
  saveCache(cache);
}

/**
 * Stop 훅 본체 — ①종료 마커를 찍고 ②알릴 게 있으면 딱 한 줄 말한다.
 *
 * 무엇을 말하지 않는가가 더 중요하다. **노출당 적립(2원대)은 절대 알리지 않는다.**
 * 매 턴 "+2원"은 알림이 아니라 잔소리이고, 금액이 작아서 알리는 순간 오히려 실망을 정확히
 * 계량해준다. 광고 줄에 적립을 붙이는 것도 금지다(브라우저 A/B에서 반증된 형식이고,
 * 상태줄은 한 줄뿐이라 유저의 기존 상태줄 폭까지 빼앗는다).
 *
 * 그래서 지금 말하는 건 **깜짝 보너스 도착** 하나뿐이다. 유저당 평생 1회, 커피값의 절반이라
 * 금액이 말이 되고, 무엇보다 이 사건은 지금 **아무도 모르게 지나가고 있었다**.
 */
function cmdStop(rawStdin = '') {
  /* ① 종료 마커(대기 감지의 짝). 원자적으로 — 렌더가 동시에 읽는 파일이다.
     ⚠️ **어느 턴이 끝났는지를 함께 적는다**(2026-08-20). 시각만 적으면 응답이 빠를 때
     Stop이 상태줄 첫 렌더보다 먼저 도착해 "시작 > 종료"가 되고, 이미 끝난 턴이 열린 것으로
     판정돼 광고가 뜬 채 굳는다. Claude Code의 **모든 훅은 stdin으로 prompt_id·session_id를
     받으므로**(공식 문서) 그걸 그대로 실어 준다. stdin이 없거나 못 읽으면 시각만 적는다. */
  let promptId = null, sessionId = null;
  try {
    const d = JSON.parse(rawStdin);
    if (typeof d?.prompt_id === 'string') promptId = d.prompt_id;
    if (typeof d?.session_id === 'string') sessionId = d.session_id;
  } catch { /* 훅 payload가 없거나 형식이 다르면 시각만으로 간다 */ }
  try {
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, 'stop.at'), JSON.stringify({ at: Date.now(), promptId, sessionId }));
  } catch { /* 마커 실패가 훅을 실패시키지 않는다 */ }

  // ② 알릴 게 있으면 한 번만. 캐시를 못 읽으면 아무 말도 하지 않는다(찢어진 읽기 규칙).
  try {
    const cache = loadCache();
    if (cache.__unreadable) return;

    /* ①.5 **상태줄이 없는 호스트에서 유일하게 열려 있는 갱신 통로**(2026-08-24).
       자가 갱신은 렌더 경로에만 있었는데, 에디터 확장처럼 상태줄 자리가 없는 호스트에서는
       렌더가 영영 안 돈다 → 그 기기는 설치한 판에 **영구 고정**된다(창업자 노트북이 서버 v13에
       로컬 v10으로 나흘을 있었다. 08-20에 고친 광고 잔존 버그도 거기엔 못 갔다).
       훅은 그런 호스트에서도 돌므로 여기서 깨운다.
       ⚠️ **훅을 붙잡지 않는다** — 떼어낸 자식에게 던지고 즉시 넘어간다(위 함수 주석 참고).
       ⚠️ 마감 시각은 **부모가 먼저 찍는다.** 자식이 찍게 두면 그 사이 도착한 다음 훅이 또
          띄워서 자식이 여럿 뜬다. 자식이 실패하면 하루를 건너뛰는데, 그건 selfUpdate가
          이미 택한 규칙("성공·실패와 무관하게 먼저 찍는다")과 같다. */
    if (updateDue(cache)) {
      cache.updateCheckedAt = Date.now();
      saveCache(cache);
      spawnDetachedMaintenance();
    }

    // 갱신 고지가 먼저다. **자동으로 바뀐 코드는 조용히 지나가면 안 된다**(2026-08-07 유저 제보).
    // 끄는 방법과 판번호를 같이 말한다 — 고지 없는 자동 갱신은 기능이 아니라 신뢰 문제다.
    const up = cache.updateNotice;
    if (up?.to) {
      delete cache.updateNotice;
      saveCache(cache);
      process.stdout.write(JSON.stringify({
        systemMessage: `틈틈이 상태줄이 v${up.from} → v${up.to}로 갱신됐어요. 전문은 ${API}/cli/statusline.mjs 에서 그대로 볼 수 있고, 자동 갱신은 TEUM_CLI_NO_UPDATE=1 로 끌 수 있어요.`,
      }));
      return;
    }

    const n = cache.notice;
    if (!n?.krw) return;
    delete cache.notice; // 한 번 말했으면 지운다(같은 소식 반복 금지)
    saveCache(cache);
    process.stdout.write(JSON.stringify({
      systemMessage: `틈틈이 · 깜짝 적립 ${Number(n.krw).toLocaleString('ko-KR')}원이 들어왔어요. 상태줄의 ⏰ 를 누르면 지갑이 열려요.`,
    }));
  } catch { /* 알림 실패가 훅을 실패시키지 않는다 */ }
}

// ── setup / remove — settings.json은 백업 후 statusLine 키만 만진다 ───────────
function readSettings(path = settingsPath) {
  if (!existsSync(path)) return { settings: {}, existed: false };
  const raw = readFileSync(path, 'utf8');
  try { return { settings: JSON.parse(raw), existed: true }; }
  catch { throw new Error(`${path} 가 올바른 JSON이 아니에요. 손대지 않았습니다 — 직접 확인 후 다시 실행하세요.`); }
}
/**
 * settings.json 쓰기는 **원자적으로**. 유저가 가진 가장 소중한 설정 파일이라,
 * 쓰는 도중 죽으면 반쪽짜리 JSON이 남아 호스트가 기동하지 못한다(우리가 망가뜨린 게 된다).
 */
function writeSettings(settings, path = settingsPath) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Gemini CLI(Antigravity)에 상태줄을 심는다. **Stop 훅은 심지 않는다** — `agent_state`가
 * 대기 종료를 직접 알려주므로 필요 없고, 남의 설정을 덜 건드릴수록 좋다.
 *
 * `stack_with_default: true` = 호스트 기본 푸터를 **유지한 채** 우리 줄을 얹는다.
 * 우리 원칙("남의 상태줄을 뺏지 않는다")을 이 호스트가 옵션으로 제공하는 것이라 그대로 쓴다.
 * ⚠️ 이미 다른 커스텀 statusLine이 있으면 그것을 `prevStatusLineGemini`로 보존해 우리가 대신
 * 실행한다(Claude Code에서 하던 "얹기"와 같은 방식).
 */
function installGemini(cache, cmd) {
  const { settings, existed } = readSettings(geminiSettingsPath);
  if (existed) {
    copyFileSync(geminiSettingsPath, join(dir, `gemini-settings-backup-${Date.now()}.json`));
  }
  if (settings.statusLine && !isOurs(settings.statusLine.command)) {
    cache.prevStatusLineGemini = settings.statusLine;
  }
  settings.statusLine = { type: 'command', command: cmd, stack_with_default: true };
  writeSettings(settings, geminiSettingsPath);
  return existed;
}

/** Gemini 쪽 우리 상태줄만 걷어낸다(있던 것은 되돌린다). 없으면 아무 것도 안 한다. */
function removeGemini(cache) {
  if (!existsSync(geminiSettingsPath)) return false;
  const { settings } = readSettings(geminiSettingsPath);
  if (!isOurs(settings.statusLine?.command)) return false;
  if (cache.prevStatusLineGemini) settings.statusLine = cache.prevStatusLineGemini;
  else delete settings.statusLine;
  writeSettings(settings, geminiSettingsPath);
  return true;
}

/** 이 기기에 설치된 호스트 — 설정 디렉터리 존재로 판별한다. */
function detectHosts() {
  return {
    claude: existsSync(join(homedir(), '.claude')) || existsSync(settingsPath),
    gemini: existsSync(dirname(geminiSettingsPath)),
  };
}


// ── 마스코트 — 설치 완료 화면 전용 ──────────────────────────────────────────
/**
 * 틈틈이 마스코트(24×24 픽셀). 한 글자 = 한 픽셀의 **색인 맵**이라 외부 의존성이 없다.
 * 렌더는 하프블록(▀): 한 칸에 세로 2픽셀을 담아 24칸 × 12줄로 그린다.
 * 색은 xterm-256(트루컬러는 일부 터미널에서 깨지지만 256색은 사실상 어디서나 동작).
 *
 * ⚠️ 왜 여기(설치 화면)에만 두는가: 상태줄은 한 줄이라 그림이 물리적으로 안 들어가고,
 * 인라인 이미지(OSC 1337)는 **호스트가 지운다**(2026-07-31 실측: 이미지 지원 터미널에서도
 * 상태줄에서만 사라짐. 같은 시퀀스를 셸에 직접 출력하면 정상 렌더). 반면 setup 출력은
 * 호스트를 거치지 않고 셸로 직행하므로 12줄을 온전히 쓸 수 있다.
 * 그리고 이 자리는 유저가 CLI에서 우리를 **정면으로 보는 유일한 순간**이다.
 */
const MASCOT_PAL = { c: 210, y: 222, w: 254, k: 235, g: 246, p: 217 };
const MASCOT = [
  '........................',
  '...yyy............yyy...',
  '..yyyyy..........yyyyy..',
  '..yyyyy..........yyyyy..',
  '....cc...........cc.....',
  '....cc...........cc.....',
  '....cc.cccccccccccc.....',
  '.....cccccccccccccc.....',
  '....cccwwwwwwwwwwccc....',
  '...cccwwwwwwwwwwwwccc...',
  '..cccwwwwkwwwwwkwwwccc..',
  '..ccwwwwkkwwwwkkwwwwcc..',
  '..ccwwwwkkwwwwkkwwwwcc..',
  '..ccwwppwwwwwwwwppwwcc..',
  '..ccwwwwwwwkwkwwwwwwcc..',
  '..ccwwwwwwwwkwwwwwwwcc..',
  '..cccwwwwwwwwwwwwwwccc..',
  '...cccwwwwwwwwwwwwccc...',
  '....cccwwwwwwwwwwccc....',
  '.....cccccccccccccc.....',
  '.......cggccccggc.......',
  '........gg....gg........',
  '........................',
  '........................',
];

/** 색을 쓸 수 없는 환경(NO_COLOR·dumb 터미널·파이프)에서는 그림을 생략한다. */
function mascotArt() {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb') return '';
  const out = [];
  for (let y = 0; y + 1 < MASCOT.length; y += 2) {
    let line = '';
    for (let x = 0; x < MASCOT[y].length; x++) {
      const u = MASCOT[y][x], l = MASCOT[y + 1][x];
      const iu = MASCOT_PAL[u], il = MASCOT_PAL[l];
      if (!iu && !il) line += ' ';
      else if (!il) line += `\x1b[38;5;${iu}m\u2580\x1b[0m`;
      else if (!iu) line += `\x1b[38;5;${il}m\u2584\x1b[0m`;
      else line += `\x1b[38;5;${iu};48;5;${il}m\u2580\x1b[0m`;
    }
    out.push('  ' + line);
  }
  // 스프라이트 위아래의 완전 투명한 줄은 빈 줄로 나오므로 잘라낸다(설치 화면 여백은 호출부가 준다).
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

const STATUSLINE_REFRESH_SEC = 3;
// 밀리초로 기록한다(초 단위면 같은 초에 시작된 턴과 구분이 안 된다). node는 이 스크립트의
// 필수 의존성이라 추가 부담이 없다. 구 설치(초 단위)는 readStopMarker가 호환 처리한다.
/**
 * Stop 훅 = "응답이 끝났다"를 알려주는 짝(대기 감지의 절반). 예전엔 셸 한 줄로 마커만 찍었는데,
 * 이제 우리 스크립트를 부른다 — 훅은 **JSON을 stdout에 내면 유저에게 한 줄을 보여줄 수 있는**
 * 유일한 자리이고, 마커 찍기와 같은 시점이기 때문이다.
 */
/**
 * 상태줄·훅에 박는 node 실행 파일 경로 — **절대경로여야 한다.**
 *
 * 2026-08-10, 창업자 노트북에서 발견. `node "..."`라고만 써 두면 호스트가 훅·상태줄을 돌리는
 * 셸의 PATH에 node가 있어야 하는데, **그 셸은 로그인 셸이 아니다.** macOS 기본 PATH는
 * `/usr/bin:/bin:/usr/sbin:/sbin`이고 Homebrew(`/opt/homebrew/bin`)도 nvm(`~/.nvm/...`)도
 * 거기 없다 — 둘 다 `.zshrc`가 넣어주는 경로다. 즉 **nvm으로 node를 깐 사람은 사실상 전원**,
 * Homebrew 유저도 상황에 따라, 설치가 성공한 뒤 상태줄이 **아무 소리 없이** 안 돈다.
 * (실제로 창업자 설치본은 08-04 16:44 이후 6일간 죽어 있었고 아무도 몰랐다. 우리 쪽에서는
 *  "CLI 유저가 조용히 이탈"과 구분이 되지 않는다 = 영영 안 보이는 종류의 고장이다.)
 *
 * `process.execPath`는 지금 이 스크립트를 돌리고 있는 node의 절대경로라 **반드시 존재한다**.
 * ⚠️ 남는 위험 하나: nvm으로 그 버전을 지우면 경로가 사라진다. v7까지는 그게 곧 영구 사망이었다
 * (되살리는 코드도 node로 돌아가므로 실행되지 않는다). v8부터는 이 경로를 **런처의 첫 후보로만**
 * 쓰고, 런처가 매 실행마다 node를 다시 찾는다 → 한 경로가 사라져도 죽지 않는다.
 *
 * ⚠️ 하나 더: `process.execPath`는 심볼릭 링크를 풀어버린다. Homebrew에서는
 * `/opt/homebrew/Cellar/node/23.11.0/bin/node` 같은 **버전이 박힌 경로**가 나오는데, 이건
 * `brew upgrade node` 한 번에 사라진다. 그래서 같은 바이너리를 가리키는 **안정된 경로가
 * 있으면 그쪽을 쓴다**(`/opt/homebrew/bin/node` 등). nvm은 원래 경로 자체가 버전별이라 그대로 둔다.
 */
function resolveNodeBin() {
  const real = process.execPath;
  for (const cand of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try {
      if (existsSync(cand) && realpathSync(cand) === realpathSync(real)) return cand;
    } catch { /* 다음 후보 */ }
  }
  return real;
}
const NODE_BIN = resolveNodeBin();
const IS_WIN = process.platform === 'win32';

/** 셸 스크립트에 그대로 박아도 안전한 절대경로인가(따옴표·달러·역따옴표·개행·백슬래시 금지). */
const shSafePath = (p) => typeof p === 'string' && p.startsWith('/') && !/["'`$\\\n\r]/.test(p);

/**
 * 런처 본문. **statusline.mjs가 생성한다 — 서버에서 내려받지 않는다.**
 * 그래서 이 문자열은 서명된 statusline.mjs 안에 있고, 런처도 릴리즈 서명 체인 안에 있다.
 *
 * 불변식(어기면 원격 코드 실행이 된다):
 *  1. 네트워크에서 온 문자열은 이 스크립트에 닿지 않는다. 여기 박히는 값은 로컬 경로뿐이다.
 *  2. 유일하게 eval하는 것은 `prev-statusline` = **유저 자신의 settings.json에서 옮겨온 명령**이다.
 *  3. 네트워크 호출을 하지 않는다(상태줄은 몇 초마다 도는 핫 패스다).
 */
function launcherSource() {
  const cands = [NODE_BIN, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
    .filter(shSafePath)
    .filter((p, i, a) => a.indexOf(p) === i)
    .map((p) => `"${p}"`)
    .join(' ');
  return `#!/bin/sh
# 틈틈이 런처 (v${VERSION}) — ~/.teum/statusline.mjs 가 생성한 파일입니다. 직접 고치지 마세요.
# 하는 일 하나: node를 찾아 상태줄 스크립트를 실행합니다.
# 못 찾으면: 아무것도 알리지 않고, 설치 전 상태줄을 그대로 실행합니다.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
T="$HOME/.teum"
S="$T/statusline.mjs"

N=""
for c in ${cands}; do
  if [ -x "$c" ]; then N="$c"; break; fi
done

# 버전 관리자(nvm·fnm·volta·asdf)는 위에서 못 찾았을 때만 훑는다(글롭 비용 회피).
# 마지막으로 발견된 것을 쓴다 — 글롭은 사전순이라 대개 최신 판이 뒤에 온다.
if [ -z "$N" ]; then
  for c in "$HOME"/.nvm/versions/node/*/bin/node \\
           "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \\
           "$HOME"/.volta/tools/image/node/*/bin/node \\
           "$HOME"/.asdf/installs/nodejs/*/bin/node; do
    if [ -x "$c" ]; then N="$c"; fi
  done
fi

if [ -n "$N" ] && [ -r "$S" ]; then
  exec "$N" "$S" "$@"
fi

# ── node가 없다 = 우리가 못 도는 상황 ───────────────────────────────────────
# 유저에게 아무것도 말하지 않는다. 우리 사정을 남의 화면에 내지 않는다.
# 흔적만 남긴다(네트워크 호출 없음). 다음에 살아나면 그때 우리에게만 보고한다.
{ date +%s > "$T/nonode"; } 2>/dev/null || true
# 인자가 없을 때 = 상태줄 자리. 설치 전 상태줄을 대신 실행해 "우리가 없던 화면"으로 되돌린다.
# (인자가 있으면 훅 등이므로 아무것도 출력하지 않는다.)
if [ "$#" -eq 0 ] && [ -r "$T/prev-statusline" ]; then
  exec sh -c "$(cat "$T/prev-statusline")"
fi
exit 0
`;
}

function writeLauncher() {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(launcherPath, launcherSource(), 0o700);
}

/** 설치 전 상태줄 명령을 셸이 읽을 수 있는 평문으로 옮긴다(런처의 폴백 재료). */
function syncPrevCmd(cache) {
  try {
    const cmd = cache?.prevStatusLine?.command;
    if (typeof cmd === 'string' && cmd.trim() && !isOurs(cmd)) atomicWrite(prevCmdPath, cmd, 0o600);
    else if (existsSync(prevCmdPath)) unlinkSync(prevCmdPath);
  } catch { /* 무해 */ }
}

/**
 * 후보 명령을 **호스트와 같은 조건에서 실제로 돌려본다.**
 * 호스트가 상태줄·훅을 돌리는 셸은 로그인 셸이 아니므로 env를 최소 PATH로 갈아 그 조건을 재현한다.
 * `selftest`는 네트워크·파일 접근 없이 TEUM_OK만 찍으므로 이 확인은 싸고 부작용이 없다.
 */
function probe(bin, args) {
  try {
    const r = spawnSync(bin, args, {
      env: IS_WIN ? process.env : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() },
      // selftest는 네트워크·파일 접근이 없어 node 기동 시간(수십 ms)이면 끝난다.
      // 넉넉히 잡되 짧게 — 이 확인은 일일 정비 안에서 돌고, 그 사이 상태줄은 대기한다.
      input: '{}', timeout: 2_500, encoding: 'utf8',
    });
    return (r.stdout || '').includes('TEUM_OK');
  } catch { return false; }
}

/**
 * 우리가 홈에 쓴 파일의 권한을 조인다.
 * `cli.json`에는 deviceId와 살아있는 지갑 세션 토큰이 있어 **읽히면 지갑이 열린다**.
 * settings 백업에는 유저의 훅·경로가 들어 있다. 둘 다 소유자만 읽게 한다.
 */
function hardenPerms() {
  const chmod = (p, m) => { try { if (existsSync(p)) chmodSync(p, m); } catch { /* 무해 */ } };
  chmod(dir, 0o700);
  for (const p of [cachePath, prevCmdPath, noNodePath, scriptPath]) chmod(p, 0o600);
  chmod(launcherPath, 0o700);
  try {
    for (const f of readdirSync(dir)) if (f.startsWith('settings-backup-')) chmod(join(dir, f), 0o600);
  } catch { /* 무해 */ }
}

/**
 * settings.json에 심을 수 있는 명령 조합은 두 가지다.
 *
 *  · LAUNCH(기본) = 런처를 거친다. node 경로가 사라져도 살아남는다.
 *  · DIRECT(폴백)  = node 절대경로를 직접 박는다(v7 방식). 윈도우(sh 부재)와,
 *                    어떤 이유로든 런처가 이 환경에서 안 도는 경우를 위해 남긴다.
 *
 * ⚠️ 어느 쪽이든 **실제로 돌려본 뒤에만** 심는다(pickCommands). 검증 없이 심으면
 * "설치는 됐는데 조용히 안 도는" 상태를 우리가 만들어내게 된다.
 */
const SL_LAUNCH = `sh "$HOME/.teum/run.sh"`;
const HOOK_LAUNCH = `sh "$HOME/.teum/run.sh" stop 2>/dev/null || true`;
const SL_DIRECT = `"${NODE_BIN}" "${scriptPath}"`;
const HOOK_DIRECT = `"${NODE_BIN}" "$HOME/.teum/statusline.mjs" stop 2>/dev/null || true`;
const STOP_HOOK_CMD_LEGACY = 'stop.at'; // 구판(마커만 찍던 셸 한 줄) 식별용
const isOurStopHook = (c) =>
  typeof c === 'string' && (c.includes(STOP_HOOK_CMD_LEGACY)
    || /\.teum[/\\]statusline\.mjs"?\s+stop\b/.test(c)
    || /\.teum[/\\]run\.sh"?\s+stop\b/.test(c));

/**
 * 설치 결과를 **1회** 보고한다(설치당 1회 = 상태줄 핫 패스가 아니다).
 *
 * 왜 필요한가: "설치는 됐는데 한 번도 안 돌았다"는 서버에서 "조용히 이탈"과 구분되지 않는다.
 * 그 구분이 없어서 2026-08-06~07 코호트 21명 중 19명이 죽은 걸 8일 뒤에야 알았다.
 * 보내는 것은 결과 코드·판번호·플랫폼뿐이다. 경로·사용자명·환경변수는 보내지 않는다.
 */
async function reportSetup(result, cache) {
  try {
    const deviceId = cache?.deviceId;
    await fetch(`${API}/v1/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(deviceId ? { 'x-device-id': deviceId } : {}) },
      body: JSON.stringify({ kind: 'cli_setup', site: 'cli', detail: `${result} v${VERSION} ${process.platform}` }),
      signal: AbortSignal.timeout(CMD_TIMEOUT_MS),
    });
  } catch { /* 보고 실패가 설치를 막을 이유는 없다 */ }
}

/**
 * 런처가 "node 못 찾음"을 남겨둔 흔적이 있으면 **살아난 지금** 1회만 보고하고 지운다.
 * 런처 자신은 네트워크를 쓰지 않는다(핫 패스라서). 보고는 이렇게 살아난 뒤에만 한다.
 */
async function reportNoNodeIfSeen(cache) {
  try {
    if (!existsSync(noNodePath)) return;
    unlinkSync(noNodePath); // 먼저 지운다 — 보고가 실패해도 매일 재시도하지 않게(폭주 방지)
    await reportSetup('recovered_no_node', cache);
  } catch { /* 무해 */ }
}

/**
 * 이 환경에서 **실제로 도는** 명령 조합을 고른다. 없으면 null = 아무것도 심지 않는다.
 * 런처를 먼저 시도하고(경로 사망에 강함), 안 되면 v7 방식(node 절대경로)으로 내려간다.
 * 프로세스당 한 번만 판정한다(상태줄은 몇 초마다 도는 핫 패스다).
 */
let pickedCommands;
function pickCommands() {
  if (pickedCommands !== undefined) return pickedCommands;
  pickedCommands = null;
  try {
    if (!IS_WIN) {
      writeLauncher();
      if (probe('sh', [launcherPath, 'selftest'])) pickedCommands = { sl: SL_LAUNCH, hook: HOOK_LAUNCH, how: 'launcher' };
    }
    if (!pickedCommands && existsSync(scriptPath) && probe(NODE_BIN, [scriptPath, 'selftest'])) {
      pickedCommands = { sl: SL_DIRECT, hook: HOOK_DIRECT, how: 'direct' };
    }
  } catch { /* null 유지 */ }
  return pickedCommands;
}

/**
 * settings.json의 우리 명령을 "지금 실제로 도는 것"으로 수렴시킨다.
 * v7의 `repairNodePath`(죽은 node 경로 갈아끼우기)와 `migrateStopHook`(구판 훅 이관)을 대체한다 —
 * 세 곳이 각자 명령을 쓰고 있었고, 그중 둘이 **검증 없이** 런처 명령을 심어 fail-open이었다.
 *
 * ⚠️ 특히 위험했던 것: 구판 Stop 훅은 `date > stop.at` 셸 한 줄이라 **node 없이도 돈다.**
 * 그걸 검증 없이 node 의존 명령으로 바꾸면 우리가 고치려던 고장을 우리가 만든다.
 * 그래서 여기서는 **돌아가는 조합을 확정한 뒤에만** 쓴다.
 */
function ensureCommands(cache) {
  try {
    const { settings, existed } = readSettings();
    if (!existed || !isOurs(settings.statusLine?.command)) return; // 우리 설치가 아니면 손대지 않는다
    syncPrevCmd(cache);
    const pick = pickCommands();
    if (!pick) { log('돌아가는 명령 조합이 없음 — settings 그대로 둠'); return; }

    let changed = false;
    if (settings.statusLine.command !== pick.sl) {
      settings.statusLine = { ...settings.statusLine, command: pick.sl };
      changed = true;
    }
    const stop = Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : null;
    const hookOk = stop?.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === pick.hook));
    if (!hookOk) {
      removeStopHook(settings);            // 구판·낡은 우리 훅만 걷어낸다(남의 훅은 보존)
      installStopHook(settings, pick.hook);
      changed = true;
    }
    if (!changed) return;
    copyFileSync(settingsPath, join(dir, `settings-backup-${Date.now()}.json`));
    writeSettings(settings);
    hardenPerms();
    log('commands converged -> ' + pick.how);
  } catch { /* 무해 — 다음 기회에 */ }
}
/**
 * "응답이 끝났다"를 알려주는 Stop 훅을 settings에 심는다(기존 훅은 보존하고 우리 것만 추가).
 * 상태줄은 자기가 언제 불릴지 못 정하므로, 종료 시점은 호스트가 알려줘야 한다.
 */
function installStopHook(settings, cmd) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  const already = stop.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurStopHook(h?.command)));
  if (!already) stop.push({ hooks: [{ type: 'command', command: cmd }] });
  settings.hooks.Stop = stop;
}

/** remove 시 우리 Stop 훅만 걷어낸다(남의 훅은 그대로). */
function removeStopHook(settings) {
  const stop = settings.hooks?.Stop;
  if (!Array.isArray(stop)) return;
  const kept = stop
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurStopHook(h?.command)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  if (kept.length) settings.hooks.Stop = kept;
  else {
    delete settings.hooks.Stop;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
}

async function cmdSetup(code) {
  mkdirSync(dir, { recursive: true });
  // 이 파일 자신을 ~/.teum/statusline.mjs 로 고정(어디에 받았든 정위치 보장).
  const self = new URL(import.meta.url).pathname;
  if (self !== scriptPath) { try { copyFileSync(self, scriptPath); } catch { /* 이미 정위치 */ } }

  /* ⚠️ 호스트 판별을 **가장 먼저** 한다(2026-08-20).
     종전엔 `~/.claude/settings.json`을 무조건 읽고 썼다 → Claude Code를 안 쓰는 사람의 홈에
     **우리가 그 파일을 새로 만들고**, 설치 요약에도 "Claude Code" 줄을 찍었다(둘 다 거짓).
     남의 기기에 없는 도구의 설정 파일을 만들지 않는다. */
  const hosts = detectHosts();
  if (!hosts.claude && !hosts.gemini) {
    console.error('설치할 곳을 찾지 못했어요.');
    console.error('   이 기기에서 Claude Code나 Gemini CLI를 찾을 수 없습니다.');
    console.error('   둘 중 하나를 먼저 설치하고 한 번 실행한 뒤에 다시 시도해 주세요.');
    process.exit(1);
  }

  let st = { settings: {}, existed: false };
  if (hosts.claude) {
    try { st = readSettings(); } catch (e) { console.error(e.message); process.exit(1); }
  }
  const { settings, existed } = st;

  if (existed) copyFileSync(settingsPath, join(dir, `settings-backup-${Date.now()}.json`)); // 백업(원복 안전망)

  const cache = loadCache();
  ensureDeviceId(cache);
  // 얹기: 기존 상태줄이 있고 우리 것이 아니면 보존(우리 줄 뒤에 계속 표시 + remove 시 원복).
  if (settings.statusLine && !isOurs(settings.statusLine.command)) {
    cache.prevStatusLine = settings.statusLine;
  }
  // refreshInterval: 주기 재실행 = 대기가 끝났을 때 **광고를 지울 기회**를 만든다.
  // 이게 없으면 호스트는 이벤트에만 상태줄을 그려서, 순수 생성이 끝나도 광고가 화면에 남는다.
  // 런처를 깔고, **호스트와 같은 조건에서 실제로 도는 조합을 확정한 뒤에** settings를 바꾼다.
  syncPrevCmd(cache);
  hardenPerms();
  const pick = pickCommands();

  if (!pick) {
    // 설치를 완료하지 않는다 — "설치는 성공했는데 조용히 안 도는" 상태를 애초에 만들지 않는다.
    // ⚠️ 2026-08-20: 이 메시지의 독자도 에이전트에서 **사람**으로 바뀌었다(`npx teumteumi`).
    // 사람에게는 먼저 "당신 설정은 그대로다"를 말하고, 진단 명령은 맨 아래에 한 줄만 둔다.
    // (상태줄에는 여전히 이런 문장을 절대 내지 않는다. 거긴 적립됨/설치 전과 동일 둘뿐이다.)
    console.error('설치를 중단했어요. 이 환경에서는 상태줄이 실행되지 않습니다.');
    console.error('   설정은 하나도 바꾸지 않았어요. 쓰시던 상태줄 그대로입니다.');
    console.error('');
    console.error('   CLI가 상태줄을 실행하는 셸에서 node를 찾지 못했습니다.');
    console.error('   (그 셸은 로그인 셸이 아니라서 nvm·homebrew 경로가 없을 수 있어요.)');
    console.error('   node를 /usr/local/bin 또는 /opt/homebrew/bin 에서 찾을 수 있게 한 뒤 다시 실행해 주세요.');
    console.error('');
    console.error(`   진단: sh -c 'PATH=/usr/bin:/bin:/usr/sbin:/sbin; command -v node'`);
    saveCache(cache);
    await reportSetup('no_node', cache);
    process.exit(1);
  }

  let claudeInstalled = false;
  if (hosts.claude) {
    settings.statusLine = { type: 'command', command: pick.sl, refreshInterval: STATUSLINE_REFRESH_SEC };
    installStopHook(settings, pick.hook); // 대기 종료 시점을 알려주는 짝(둘이 있어야 "대기 중에만"이 완성된다)
    writeSettings(settings);
    claudeInstalled = true;
  }

  // 🖥️ 설치된 다른 CLI에도 함께 심는다 = "하나의 정체성, 여러 지면". 유저가 어느 CLI를 쓰는지
  // 우리에게 말하게 하지 않는다(비침투). 없으면 조용히 건너뛴다.
  let geminiInstalled = false;
  if (hosts.gemini) {
    try { installGemini(cache, pick.sl); geminiInstalled = true; }
    catch (e) { console.error('Gemini CLI 설정을 건드리지 못했어요: ' + (e?.message ?? e)); }
  }
  saveCache(cache);
  await reportSetup(geminiInstalled ? 'ok+gemini' : 'ok', cache);

  const art = mascotArt();
  if (art) console.log('\n' + art + '\n');

  /* ⚠️ 이 출력의 독자가 바뀌었다(2026-08-20).
     종전엔 설치를 대행하는 **에이전트**가 읽었지만, `npx teumteumi`로 들어오면 **사람**이 읽는다.
     그래서 ①무엇이 어디에 설치됐는지 표로 보여주고 ②되돌리는 법을 **자기가 친 명령으로** 말한다.
     (스크립트는 자기가 어떻게 불렸는지 모른다 → 진입점이 TEUM_ENTRY로 알려준다.) */
  console.log('설치됐어요');
  // ⚠️ **실제로 쓴 곳만** 적는다. 종전엔 Claude Code 줄을 무조건 찍어서, 그 도구를 쓰지도 않는
  //    사람에게 거짓을 말하고 있었다(게다가 그 파일을 우리가 만들고 있었다).
  if (claudeInstalled) console.log(`   Claude Code   ${tildePath(settingsPath)}   상태줄 + Stop 훅`);
  if (geminiInstalled) console.log(`   Gemini CLI    ${tildePath(geminiSettingsPath)}   상태줄`);
  else if (hosts.gemini) console.log('   Gemini CLI    설정을 건드리지 못했어요');
  console.log('');
  if (cache.prevStatusLine) console.log('   쓰시던 상태줄은 그대로 두고 그 뒤에 광고 한 칸만 얹었어요.');
  console.log('   CLI를 다시 열면 화면 아래 상태줄에 광고 한 줄이 뜨고, 기다리는 동안 적립돼요.');
  if (geminiInstalled) console.log('   Gemini CLI는 완전히 껐다 켜야 반영돼요.');
  // 지갑으로 가는 길은 **명령이 아니라 상태줄의 ⏰**다(비침투: 유저에게 무엇도 시키지 않는다).
  // 여기서 명령을 안내하면 그 순간 "우리 편의를 위해 유저 행동을 바꾸는" 도구가 된다.
  console.log('   상태줄 맨 앞 ⏰ 를 누르면 내 지갑이 열려요(하이퍼링크 지원 터미널).');
  console.log('');
  // 적립은 상태줄이 그려질 때만 일어난다. IDE 확장 채팅 패널에는 상태줄 자리가 없어
  // "설치는 성공했는데 적립이 0"이 되므로, 안내문을 안 읽고 설치한 경우를 대비해 여기서도 못 박는다.
  console.log('   적립되는 화면은 터미널에서 실행한 CLI의 상태줄이에요.');
  console.log('   IDE 확장 채팅 패널에는 상태줄이 없어서 그 화면에서는 적립되지 않아요.');
  console.log(`   되돌리기: ${entryCommand()} remove`);

  if (code) await cmdLink(code, { fromSetup: true });
}

function cmdRemove() {
  let st;
  try { st = readSettings(); } catch (e) { console.error(e.message); process.exit(1); }
  const { settings } = st;
  if (!isOurs(settings.statusLine?.command)) {
    console.log('틈틈이 상태줄이 설치돼 있지 않아요. 바꾼 것이 없습니다.');
    return;
  }
  const cache = loadCache();
  if (cache.prevStatusLine) settings.statusLine = cache.prevStatusLine; // 원래 상태줄 복원
  else delete settings.statusLine;
  removeStopHook(settings);
  writeSettings(settings);
  let g = false;
  try { g = removeGemini(cache); } catch { /* 남의 설정이 깨져 있으면 건드리지 않는다 */ }
  saveCache(cache);
  console.log(`원복했어요${g ? ' (Claude Code + Gemini CLI)' : ''}. 쓰시던 상태줄로 되돌렸습니다.`);
  console.log('   적립 데이터는 ~/.teum 에 남아 있어요. 완전히 지우려면: rm -rf ~/.teum');
}

// ── link / wallet ────────────────────────────────────────────────────────────
async function cmdLink(code, opts = {}) {
  if (!code || !code.trim()) {
    console.error(`사용법: ${entryCommand()} link <코드>\n  코드는 지갑 페이지(확장 팝업 → 내 지갑)에서 받을 수 있어요.`);
    process.exit(1);
  }
  const cache = loadCache();
  const deviceId = ensureDeviceId(cache);
  try {
    const res = await fetch(`${API}/v1/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), deviceId, surface: 'cli' }),
      signal: AbortSignal.timeout(CMD_TIMEOUT_MS),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* ⚠️ 실패 이유마다 다음 걸음이 다르다. 종전엔 전부 "코드 만료"로 안내해서,
         잔액 때문에 막힌 사람에게 **평생 안 되는 방법**을 알려주고 있었다(막다른 길). */
      if (d.nextStep === 'passkey_merge') {
        console.error('이 기기에 이미 모인 금액이 있어요.');
        // ⚠️ 터미널이다. 마크다운 별표는 그대로 글자로 찍힌다(실제로 그렇게 나갔다).
        console.error(`   ${KRW(d.availableKrw)}가 함께 옮겨지는 합치기는 지갑 페이지에서 패스키로만 할 수 있어요.`);
        console.error('   (코드 한 장으로 돈을 옮길 수 있으면 남이 그렇게 할 수도 있으니까요.)');
        console.error(`   지갑 열기: ${entryCommand()} wallet → "패스키로 합치기"`);
      } else if (d.error === 'source sealed') {
        console.error('이 기기의 지갑은 패스키로 잠겨 있어요.');
        console.error(`   잠근 지갑은 코드로 옮길 수 없어요. 지갑 페이지에서 패스키로 합쳐 주세요: ${entryCommand()} wallet`);
      } else {
        console.error(`지갑 연결 실패: ${d.error || res.status}`);
        console.error(`   코드가 만료(30분)됐거나 이미 사용됐어요. 지갑 페이지에서 새 코드를 받아 다시: ${entryCommand()} link <코드>`);
      }
      if (!opts.fromSetup) process.exit(1);
      return;
    }
    console.log(d.alreadyLinked ? '   지갑: 이미 연결돼 있어요' : '지갑 연결 완료 — 터미널 적립이 브라우저와 같은 지갑에 모여요.');
    console.log(`   현재 잔액 ${KRW(d.availableKrw)}`);
  } catch (e) {
    console.error(`네트워크 오류: ${e?.message || e}`);
    if (!opts.fromSetup) process.exit(1);
  }
}

/**
 * 기본 브라우저로 URL 열기. 열기에 실패해도 **URL은 이미 출력돼 있으므로** 조용히 넘어간다.
 * spawn의 실패(opener 미설치 등)는 동기 throw가 아니라 'error' 이벤트라, 리스너가 없으면
 * uncaught로 프로세스가 죽는다 → 반드시 붙인다.
 */
function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const p = spawn(opener, [url], { stdio: 'ignore', detached: true });
    p.on('error', () => { /* 수동으로 URL 복사하면 됨 */ });
    p.unref();
  } catch { /* URL은 이미 출력됨 */ }
}

async function cmdWallet() {
  const cache = loadCache();
  const deviceId = ensureDeviceId(cache);
  try {
    // ⚠️ 여기서 만든 URL은 **화면에 글자로 찍힌다**(OSC 8 링크와 달리 스크린샷에 그대로 남는다).
    // 그래서 오히려 더 짧게 받는다 — 유저는 지금 열려고 친 것이므로 30분이면 충분하다.
    const res = await fetch(`${API}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': deviceId },
      body: JSON.stringify({ ttlMinutes: DOOR_TTL_MIN }),
      signal: AbortSignal.timeout(CMD_TIMEOUT_MS),
    });
    const d = await res.json();
    if (!d?.token) throw new Error('no token');
    const url = `${API}/wallet?t=${encodeURIComponent(d.token)}`;
    // 보상 맥락이라 커피(☕)를 쓴다. 광고 맥락(상태줄·ad)은 ⏰ — 역할 분리(2026-07-31).
    console.log('내 지갑 열기:\n   ' + url);
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    openUrl(url);
  } catch (e) {
    console.error('지갑을 열 수 없어요: ' + (e?.message || e));
    process.exit(1);
  }
}

/**
 * 지금 상태줄에 뜬 광고를 브라우저로 연다(클릭 집계 포함).
 *
 * 왜 명령이 필요한가: 상태줄 문구를 OSC 8 하이퍼링크로 감싸도 **TUI 안에서는 클릭이 신뢰할 수 없다**
 * (전체화면 TUI가 마우스 이벤트를 먹어 터미널의 링크 핸들러까지 내려가지 않는 경우가 많다.
 *  2026-07-30 창업자 실환경에서 클릭 불가 확인). 링크는 지원 환경을 위해 남겨두고,
 * 어디서나 동작하는 확실한 경로를 하나 준다.
 *
 * 집계는 URL이 우리 서버(`/c?t=`)를 지나며 이뤄진다 → 확장 클릭과 같은 원장에 같은 방식으로 쌓인다.
 */
function cmdAd() {
  const cache = loadCache();
  const ad = cache.ad;
  if (!ad?.headline) {
    console.log('지금 표시 중인 광고가 없어요. Claude Code를 잠깐 쓰면 상태줄에 광고가 떠요.');
    return;
  }
  console.log(`⏰ ${ad.headline}${ad.advertiserName ? ` — ${ad.advertiserName}` : ''}`);
  if (!ad.clickToken) {
    // 구버전 서버가 준 캐시(clickToken 없음) — 다음 광고부터 동작한다.
    console.log('   이 광고에는 링크 정보가 없어요(다음 광고부터 열 수 있어요).');
    return;
  }
  const url = `${API}/c?t=${encodeURIComponent(ad.clickToken)}`;
  console.log('   ' + url);
  openUrl(url);
}

// ── 디스패치 ────────────────────────────────────────────────────────────────
/**
 * `statusline.mjs verify` — **유저가 우리를 믿지 않고도 확인할 수 있는 자리.**
 *
 * 보안 제보를 받고 만들었다(2026-08-07). 자가 갱신이 있는 이상 "우리를 믿어달라"는 말은
 * 답이 될 수 없다. 그래서 확인에 필요한 세 가지를 한 화면에 놓는다:
 *   ① 내 기기에 설치된 파일의 SHA-256 (내가 실제로 실행 중인 것)
 *   ② 서버가 지금 주는 파일의 SHA-256과 그 서명이 우리 릴리즈 키로 검증되는지
 *   ③ 우리 서버가 아닌 곳에 공개된 해시 목록 주소 (①②가 저기 적힌 값과 같아야 한다)
 * ①과 ②가 다르면 갱신이 아직 안 왔거나 누군가 파일을 바꾼 것이고,
 * ②가 검증에 실패하면 그 판은 우리가 서명한 것이 아니다.
 */
async function cmdVerify() {
  const local = existsSync(scriptPath) ? readFileSync(scriptPath) : null;
  const localHash = local ? createHash('sha256').update(local).digest('hex') : null;
  console.log(`\n틈틈이 상태줄 검증\n`);
  console.log(`  설치 위치     ${scriptPath}`);
  console.log(`  설치된 판      v${VERSION}`);
  console.log(`  설치본 SHA-256 ${localHash ?? '(파일 없음)'}`);

  try {
    const r = await fetch(`${API}/cli/statusline.mjs`, { signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    const serverHash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
    const sigRes = await fetch(`${API}/cli/statusline.mjs.sig`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const sig = sigRes?.ok ? (await sigRes.text()).trim() : '';
    const ok = sig ? verifyRelease(body, sig) : false;
    console.log(`  서버 최신 판   v${/const VERSION = '([^']+)'/.exec(body)?.[1] ?? '?'}`);
    console.log(`  서버본 SHA-256 ${serverHash}`);
    console.log(`  서명 검증      ${ok ? '우리 릴리즈 키로 서명됨' : '서명 없음/불일치 — 이 판은 설치되지 않습니다'}`);
    if (localHash && localHash !== serverHash) {
      console.log(`\n  설치본과 서버본이 다릅니다(아직 갱신 전이거나, 누군가 파일을 바꿨습니다).`);
    }
  } catch (e) {
    console.log(`  서버 확인      실패(${e?.name ?? e}) — 네트워크만 확인해 보세요`);
  }

  console.log(`\n  공개 해시 목록 ${RELEASES_URL}`);
  console.log(`  전문 보기      ${API}/cli/statusline.mjs`);
  console.log(`  변경 내역      ${API}/cli/CHANGELOG.md`);
  console.log(`\n  자동 갱신 끄기 TEUM_CLI_NO_UPDATE=1`);
  console.log(`  완전히 제거    node ${scriptPath} remove\n`);
}

const cmd = process.argv[2];
if (cmd === 'setup') cmdSetup(process.argv[3]);
else if (cmd === 'link') cmdLink(process.argv[3]);
else if (cmd === 'wallet' || cmd === 'open') cmdWallet();
else if (cmd === 'ad' || cmd === 'click') cmdAd();
else if (cmd === 'remove') cmdRemove();
// ⚠️ 훅 payload(prompt_id·session_id)를 넘겨야 "어느 턴이 끝났는지"를 마커에 적을 수 있다.
// 안 넘기면 조용히 시각만 적는 예전 동작으로 돌아간다(고쳤다고 착각하기 딱 좋은 자리).
else if (cmd === 'stop') { let s = ''; try { s = readFileSync(0, 'utf8'); } catch { /* stdin 없음 */ } cmdStop(s); }
else if (cmd === 'verify') cmdVerify();
// 정비 전용 진입점 — Stop 훅이 떼어낸 자식으로 부른다(상태줄 없는 호스트의 유일한 갱신 통로).
// **마감 시각은 부모가 이미 찍었으므로 여기서 updateDue를 다시 보지 않는다**(보면 늘 false다).
else if (cmd === 'update') cmdUpdate();
// "이 환경에서 실제로 실행되는가"만 답한다. 네트워크·파일 접근 없이 즉시 끝난다 —
// 설치 검증(pickCommands → probe)이 이 한 줄을 보고 통과/중단을 가른다.
else if (cmd === 'selftest') process.stdout.write(`TEUM_OK v${VERSION}\n`);
else statusline();
