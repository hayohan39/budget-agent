// 토스뱅크 거래내역 xlsx 업로드 -> 파싱 -> Neon 저장.
//
// 이 파일은 껍데기다. 인증 · Origin 확인 · multipart 해석 · 직렬화만 한다.
// 실제 흐름은 lib/import/statement.mjs 에 있다(Next.js 없이 단위 테스트한다).
//
// ── 보안 ───────────────────────────────────────────────────────────────────
//
//   - 세션과 화이트리스트를 **본문을 읽기 전에** 확인한다. 인증되지 않은 요청이
//     파일 바이트를 메모리에 올리게 두지 않는다.
//   - 업로드 파일은 Buffer 로만 다룬다. 디스크(os.tmpdir() 포함)에 쓰지 않는다.
//   - 응답 본문에 거래 내용을 넣지 않는다. 건수 · 역할 · 조회기간 · 경고 코드뿐.
//     계좌 뒤 4자리도 내보내지 않는다.
//   - console 호출이 이 파일에 없다. 에러 객체 · 스택 · DB 메시지는 어디로도
//     나가지 않는다(CLAUDE.md).
//   - **파일 비밀번호는 저장하지 않는다.** 이 요청의 multipart 본문에서 한 번
//     읽어 importStatementBuffer 에 넘기고 끝이다. 환경변수 · DB · 파일 어디에도
//     두지 않고, 응답으로 되비추지도 않으며, 길이조차 알리지 않는다.
import { NextResponse } from "next/server";

import { auth, isAllowedEmail } from "@/auth";
import { listAccounts } from "@/lib/db/accounts.mjs";
import { withClient } from "@/lib/db/client.mjs";
import {
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  importStatementBuffer,
} from "@/lib/import/statement.mjs";
import { MAX_PASSWORD_LENGTH } from "@/lib/xlsx/crypto.mjs";

// 파서가 node:zlib · node:crypto 를 쓰고 저장은 pg 를 쓴다. Edge 에서는 둘 다
// 돌지 않는다.
export const runtime = "nodejs";

/** 업로드 필드 이름. app/import 의 폼과 맞춰 둔다. */
export const FILE_FIELD = "files";

/**
 * 암호가 걸린 xlsx 의 비밀번호 필드 이름. app/import 의 폼과 맞춰 둔다.
 *
 * 값은 이 요청 안에서만 산다. 서버 어디에도 저장하지 않는다(사용자가 정한
 * 방침이다) — 저장하지 않은 값은 유출될 수 없다.
 */
export const PASSWORD_FIELD = "password";

/** 되비추는 파일명 길이 상한. 사용자가 준 값 그대로지만 무한정 길 수 있다. */
const MAX_FILENAME_LENGTH = 200;

type FileResult = {
  filename: string;
  ok: boolean;
  account?: { role: string; nickname: string };
  period?: { from: string; to: string };
  inserted?: number;
  skipped?: number;
  warnings?: string[];
  error?: string;
  message?: string;
};

function bare(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Origin 확인.
 *
 * SameSite 세션 쿠키가 1차 방어선이고 이것은 그 위에 덧대는 층이다. Origin 이
 * 아예 없는 요청(같은 출처의 폼 전송 등)은 통과시키고, 있는데 호스트가 다르면
 * 거부한다.
 */
function originMatchesHost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return true;

  const host = request.headers.get("host");
  if (host === null || host === "") return false;

  try {
    return new URL(origin).host === host;
  } catch {
    // 파싱되지 않는 Origin 은 통과시키지 않는다. 값은 메시지에 넣지 않는다.
    return false;
  }
}

function toSafeFilename(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "(이름 없음)";
  // 제어문자를 걷어 낸다. 이 값은 사용자 본인에게 되비칠 뿐이지만, 로그·터미널을
  // 흔드는 바이트를 그대로 돌려줄 이유가 없다.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.slice(0, MAX_FILENAME_LENGTH) || "(이름 없음)";
}

export async function POST(request: Request) {
  // 1. 인증. 본문은 아직 건드리지 않는다.
  const session = await auth();
  if (!session) return bare("로그인이 필요합니다.", 401);
  if (!isAllowedEmail(session.user?.email)) {
    return bare("접근 권한이 없습니다.", 403);
  }

  // 2. Origin.
  if (!originMatchesHost(request)) {
    return bare("허용되지 않은 요청입니다.", 403);
  }

  // 3. multipart 해석.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bare("업로드 형식이 올바르지 않습니다.", 400);
  }

  const uploads = form
    .getAll(FILE_FIELD)
    .filter((entry): entry is File => typeof entry === "object" && entry !== null && "arrayBuffer" in entry)
    // 파일을 고르지 않은 채 폼을 보내면 브라우저는 이름도 내용도 없는 파트를
    // 하나 실어 보낸다. 그것은 "파일 0개"로 센다.
    .filter((file) => file.size > 0 || file.name !== "");

  if (uploads.length === 0) {
    return bare("올릴 파일을 선택해 주세요.", 400);
  }
  if (uploads.length > MAX_FILE_COUNT) {
    return bare(`한 번에 ${MAX_FILE_COUNT}개까지만 올릴 수 있습니다.`, 400);
  }

  // 4. 비밀번호. 파일마다 따로 받지 않는다 — 세 계좌가 같은 비밀번호다.
  //    값은 읽어서 넘기기만 한다. 로그에도 응답에도 담지 않고, 길이가 상한을
  //    넘으면 그 사실만 알린다(값도, 실제 길이도 말하지 않는다).
  const rawPassword = form.get(PASSWORD_FIELD);
  if (rawPassword !== null && typeof rawPassword !== "string") {
    return bare("비밀번호 형식이 올바르지 않습니다.", 400);
  }
  if (typeof rawPassword === "string" && rawPassword.length > MAX_PASSWORD_LENGTH) {
    return bare(`비밀번호는 ${MAX_PASSWORD_LENGTH}자까지만 쓸 수 있습니다.`, 400);
  }
  // 빈 문자열은 "입력하지 않음" 과 같다. 브라우저는 빈 입력칸도 실어 보낸다.
  const password =
    typeof rawPassword === "string" && rawPassword.length > 0 ? rawPassword : undefined;

  // 5. 크기. 파싱 전에, 바이트를 읽기 전에 막는다.
  const oversize = uploads.filter((file) => file.size > MAX_FILE_BYTES);
  if (oversize.length > 0) {
    return bare(
      `한 파일당 ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB 까지만 올릴 수 있습니다.`,
      413,
    );
  }

  // 6. 파일별 처리. 하나가 실패해도 나머지는 계속한다.
  let results: FileResult[];
  try {
    results = await withClient(async (client) => {
      const accounts = await listAccounts(client);
      const collected: FileResult[] = [];

      for (const file of uploads) {
        const filename = toSafeFilename(file.name);
        let buffer: Buffer;
        try {
          // 메모리에서만 다룬다. 어떤 경로로도 디스크에 쓰지 않는다.
          buffer = Buffer.from(await file.arrayBuffer());
        } catch {
          collected.push({ filename, ok: false, error: "readFailed", message: "파일을 읽지 못했습니다." });
          continue;
        }

        const outcome = await importStatementBuffer(buffer, { client, accounts, password });
        collected.push({ filename, ...outcome });
      }

      return collected;
    });
  } catch {
    // 연결 실패 · 계좌 목록 조회 실패. 원인 객체는 어디로도 내보내지 않는다.
    return bare("데이터베이스에 연결하지 못했습니다.", 503);
  }

  return NextResponse.json({ results });
}
