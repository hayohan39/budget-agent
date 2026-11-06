// 연말정산 가이드 탭 — docs/year-end-tax-guide.md 를 그대로 보여 준다.
//
// ── 원문은 하나 ─────────────────────────────────────────────────────────────
//
// 내용은 docs/year-end-tax-guide.md 에만 있다. 이 화면은 그 파일을 빌드할 때 한 번 읽어
// 블록 트리(lib/markdown/blocks.mjs)로 바꾼 뒤 그린다. 가이드를 고치면 다음 배포에
// 반영된다. 화면 쪽에 문구를 따로 두지 않는다.
//
// ── 왜 정적인가 (다른 화면과 다른 점) ─────────────────────────────────────────
//
// /report · /classify · /stats 는 요청마다 세션 + 화이트리스트를 다시 보고 동적으로
// 렌더한다. 거래 데이터를 보여 주기 때문이다. 이 화면은 사용자 데이터가 하나도 없고,
// 내용은 공개 리포에 있는 문서와 같다. 그래서 빌드 때 구워 둔다(`force-static`).
// 로그인 관문은 그대로다 — middleware 의 matcher 가 `/tax/guide` 도 덮는다(예외 목록에 없다).
// 이 화면에 사용자 데이터를 더하게 되면 다른 화면처럼 동적 렌더 + 요청마다 검사로 바꾼다.
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Metadata } from "next";

import type { Block, Inline } from "@/lib/markdown/blocks.mjs";
import { parseMarkdown } from "@/lib/markdown/blocks.mjs";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "연말정산 가이드 · 가계부",
};

const GUIDE_PATH = path.join(process.cwd(), "docs", "year-end-tax-guide.md");

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.text;
    if (node.type === "code") {
      return (
        <code key={index} className="rounded bg-subtle px-1 py-px font-mono text-[0.92em]">
          {node.text}
        </code>
      );
    }
    return (
      <strong key={index} className="font-semibold text-fg">
        <InlineNodes nodes={node.children} />
      </strong>
    );
  });
}

function GuideBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      if (block.level <= 2) {
        return (
          <h2 id={block.id} className="scroll-mt-4 pt-2 text-lg font-semibold tracking-tight">
            <InlineNodes nodes={block.inline} />
          </h2>
        );
      }
      return (
        <h3 id={block.id} className="scroll-mt-4 pt-2 text-[15px] font-semibold">
          <InlineNodes nodes={block.inline} />
        </h3>
      );
    }
    case "paragraph":
      return (
        <p className="leading-7 text-soft">
          <InlineNodes nodes={block.inline} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className="pl-1">
          <InlineNodes nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="list-decimal space-y-1 pl-5 leading-7 text-soft">
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5 leading-7 text-soft">{items}</ul>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse text-[13px] leading-6">
            <thead className="bg-subtle">
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} scope="col" className="px-3 py-2 text-left font-medium whitespace-nowrap">
                    <InlineNodes nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-line">
                  {row.map((cell, index) => (
                    <td key={index} className="min-w-28 px-3 py-2 align-top text-soft">
                      <InlineNodes nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md bg-subtle px-4 py-3 font-mono text-xs leading-5">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <div className="flex flex-col gap-3 rounded-md border border-line bg-subtle px-4 py-3 text-[13px]">
          {block.blocks.map((child, index) => (
            <GuideBlock key={index} block={child} />
          ))}
        </div>
      );
    case "hr":
      return <hr className="border-line" />;
  }
}

export default function TaxGuidePage() {
  const blocks = parseMarkdown(readFileSync(GUIDE_PATH, "utf8"));

  // 문서의 첫 # 제목이 화면 제목이다. 목차는 ## 제목들로 만든다.
  const titleIndex = blocks.findIndex((block) => block.type === "heading" && block.level === 1);
  const title = titleIndex >= 0 ? (blocks[titleIndex] as Extract<Block, { type: "heading" }>).text : "연말정산 가이드";
  const body = blocks.filter((_, index) => index !== titleIndex);
  const sections = body.filter(
    (block): block is Extract<Block, { type: "heading" }> => block.type === "heading" && block.level === 2,
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pt-4 pb-6 break-keep sm:px-8 sm:pt-5 sm:pb-8">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>

      {sections.length > 0 ? (
        <nav aria-label="목차" className="rounded-md border border-line px-4 py-3 text-[13px]">
          <p className="mb-1 font-medium">목차</p>
          <ol className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-muted hover:text-fg hover:underline">
                  {section.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      {body.map((block, index) => (
        <GuideBlock key={index} block={block} />
      ))}
    </main>
  );
}
