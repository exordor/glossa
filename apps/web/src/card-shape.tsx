/**
 * 画布卡片：tldraw 自定义 shape，按设计系统 NodeCard / QACard / CardStates 渲染。
 * 公开选择器 [data-rc="card"][data-type][data-group][data-state] 给主题用。
 */
import { HTMLContainer, Rectangle2d, ShapeUtil, T, type TLShape } from "tldraw";
import { Icon, type IconName } from "./icons";
import { MarkdownCompact } from "./mini-markdown";

export const CARD_TYPE = "rd-card";

export interface CardProps {
  w: number;
  h: number;
  nodeId: string;
  nodeType: string;
  group: string;
  state: string;
  createdBy: string;
  crumb: string;
  title: string;
  quotePre: string;
  quoteHit: string;
  quotePost: string;
  body: string;
  hasAnchor: boolean;
  /** 回答卡底部的引用校验说明；空串不显示。 */
  cite: string;
  citeWarn: boolean;
}

declare module "tldraw" {
  export interface TLGlobalShapePropsMap {
    [CARD_TYPE]: CardProps;
  }
}

export type CardShape = TLShape<typeof CARD_TYPE>;

const TYPE_ICON: Record<string, IconName> = {
  chapter: "node-chapter",
  excerpt: "node-excerpt",
  operation: "node-operation",
  answer: "node-answer",
  note: "node-note",
  group: "node-group",
};

/** 状态徽章：一张卡最多一个，优先级 失败 > 过期 > 锚点失效。永远是图标 + 文字。 */
const STATE_BADGE: Record<string, { icon: IconName; text: string; cls: string } | undefined> = {
  failed: { icon: "st-failed", text: "失败", cls: "rc-badge-failed" },
  stale: { icon: "st-stale", text: "过期", cls: "rc-badge-stale" },
  broken: { icon: "st-broken", text: "锚点失效", cls: "rc-badge-broken" },
};

/** 卡片里的按钮：阻止事件冒泡到画布，否则点按钮会变成拖卡片。 */
const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();

export function emitLocate(nodeId: string) {
  window.dispatchEvent(new CustomEvent("glossa:locate", { detail: { nodeId } }));
}

/** 失败的回答卡上的「重试」：BookView 监听，用同一请求重新生成。 */
export function emitRetry(nodeId: string) {
  window.dispatchEvent(new CustomEvent("glossa:retry", { detail: { nodeId } }));
}

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = CARD_TYPE;
  static override props = {
    w: T.number,
    h: T.number,
    nodeId: T.string,
    nodeType: T.string,
    group: T.string,
    state: T.string,
    createdBy: T.string,
    crumb: T.string,
    title: T.string,
    quotePre: T.string,
    quoteHit: T.string,
    quotePost: T.string,
    body: T.string,
    hasAnchor: T.boolean,
    cite: T.string,
    citeWarn: T.boolean,
  };

  override canResize = () => false;
  override canEdit = () => false;
  override hideRotateHandle = () => true;

  getDefaultProps(): CardProps {
    return {
      w: 320,
      h: 120,
      nodeId: "",
      nodeType: "note",
      group: "user",
      state: "idle",
      createdBy: "user",
      crumb: "",
      title: "",
      quotePre: "",
      quoteHit: "",
      quotePost: "",
      body: "",
      hasAnchor: false,
      cite: "",
      citeWarn: false,
    };
  }

  getGeometry(shape: CardShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  getIndicatorPath(shape: CardShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 8);
    return path;
  }

  component(shape: CardShape) {
    const p = shape.props;
    const far = this.editor.getZoomLevel() < 0.4;
    const selected = this.editor.getSelectedShapeIds().includes(shape.id);
    const badge = STATE_BADGE[p.state];
    const quote = p.quoteHit || p.quotePre || p.quotePost;
    const label = [p.title || p.body || p.quoteHit, p.crumb].filter(Boolean).join("，");
    return (
      <HTMLContainer>
        <article
          className="rc-card"
          data-rc="card"
          data-type={p.nodeType}
          data-group={p.group}
          data-state={p.state}
          data-zoom={far ? "far" : undefined}
          aria-selected={selected}
          aria-busy={p.state === "running" || undefined}
          aria-label={label}
          role="article"
          style={{ width: p.w, height: p.h }}
        >
          {p.createdBy === "agent" && (
            <span className="rc-agent-tag" title="由外部 agent 创建">
              <Icon name="agent" size={16} />
            </span>
          )}
          <div className="rc-card-head">
            <Icon name={TYPE_ICON[p.nodeType] ?? "node-note"} />
            <span className="rc-crumb">{p.crumb}</span>
            <span className="rc-card-actions">
              {p.state === "running" && <Icon name="st-running" className="rc-spin" />}
              {badge && (
                <span className={`rc-badge ${badge.cls}`}>
                  <Icon name={badge.icon} />
                  {badge.text}
                </span>
              )}
              {p.nodeType === "answer" && p.state === "failed" && (
                <button
                  className="rc-iconbtn rc-iconbtn-sm rc-retry"
                  aria-label="重试"
                  title="重试"
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    emitRetry(p.nodeId);
                  }}
                >
                  <Icon name="st-retry" />
                </button>
              )}
              {p.hasAnchor && (
                <button
                  className="rc-iconbtn rc-iconbtn-sm rc-locate"
                  aria-label={p.state === "broken" ? "跳回原文（不可用）" : "跳回原文"}
                  title="跳回原文"
                  disabled={p.state === "broken"}
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    emitLocate(p.nodeId);
                  }}
                >
                  <Icon name="locate" />
                </button>
              )}
            </span>
          </div>
          {p.title && <h3 className={p.nodeType === "operation" ? "rc-card-question" : "rc-card-title"}>{p.title}</h3>}
          {quote && (
            <p className="rc-card-quote">
              {p.quotePre}
              <b>{p.quoteHit}</b>
              {p.quotePost}
            </p>
          )}
          {p.body && (
            <p className="rc-card-body">
              <MarkdownCompact text={p.body} />
            </p>
          )}
          {p.cite && (
            <p className="rc-card-cite" data-warn={p.citeWarn} title={p.cite}>
              <Icon name="node-excerpt" />
              {p.cite}
            </p>
          )}
        </article>
      </HTMLContainer>
    );
  }
}
