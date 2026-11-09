/**
 * 画布连线：三种 role 只靠线型和箭头区分（设计系统 Edge）。
 * context 实线 + 两端空心端点；derived 实线 + 开口箭头；reference 虚线，可带标签。颜色一律 edge 灰。
 * 连线不参与命中测试，位置每次从两端卡片现算，所以卡片拖动时跟着走。
 */
import { focusAtom } from "./focus";
import { Rectangle2d, SVGContainer, ShapeUtil, T, type TLShape, type TLShapeId } from "tldraw";

export const EDGE_TYPE = "rd-edge";

export interface EdgeProps {
  from: string;
  to: string;
  role: string;
  label: string;
}

declare module "tldraw" {
  export interface TLGlobalShapePropsMap {
    [EDGE_TYPE]: EdgeProps;
  }
}

export type EdgeShape = TLShape<typeof EDGE_TYPE>;

const ARROW = 7;
const DOT = 3.5;

export class EdgeShapeUtil extends ShapeUtil<EdgeShape> {
  static override type = EDGE_TYPE;
  static override props = { from: T.string, to: T.string, role: T.string, label: T.string };

  override canResize = () => false;
  override canEdit = () => false;
  override canCull = () => false;
  override hideRotateHandle = () => true;
  override hideSelectionBoundsFg = () => true;
  override hideSelectionBoundsBg = () => true;

  getDefaultProps(): EdgeProps {
    return { from: "", to: "", role: "context", label: "" };
  }

  /** 极小的几何：连线本身不可点选。 */
  getGeometry() {
    return new Rectangle2d({ width: 0.01, height: 0.01, isFilled: false });
  }

  getIndicatorPath() {
    return new Path2D();
  }

  private endpoints(shape: EdgeShape) {
    const a = this.editor.getShapePageBounds(`shape:${shape.props.from}` as TLShapeId);
    const b = this.editor.getShapePageBounds(`shape:${shape.props.to}` as TLShapeId);
    if (!a || !b) return null;
    // 水平方向分得开：右中 → 左中；否则上下排列：下中 → 上中。
    if (b.minX >= a.maxX || a.minX >= b.maxX) {
      const ltr = b.minX >= a.maxX;
      return {
        x1: ltr ? a.maxX : a.minX, y1: a.midY,
        x2: ltr ? b.minX : b.maxX, y2: b.midY,
        horizontal: true, sign: ltr ? 1 : -1,
      };
    }
    const down = b.minY >= a.midY;
    return {
      x1: a.midX, y1: down ? a.maxY : a.minY,
      x2: b.midX, y2: down ? b.minY : b.maxY,
      horizontal: false, sign: down ? 1 : -1,
    };
  }

  component(shape: EdgeShape) {
    const e = this.endpoints(shape);
    if (!e) return null;
    const { x1, y1, x2, y2, horizontal, sign } = e;
    const focus = focusAtom.get();
    const dim = focus !== null && !(focus.has(shape.props.from) && focus.has(shape.props.to));
    const k = Math.max(40, (horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) / 2);
    const c1 = horizontal ? [x1 + sign * k, y1] : [x1, y1 + sign * k];
    const c2 = horizontal ? [x2 - sign * k, y2] : [x2, y2 - sign * k];
    const d = `M${x1},${y1} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${x2},${y2}`;
    const role = shape.props.role;
    // 箭头沿最后一段切线方向
    const ang = Math.atan2(y2 - c2[1]!, x2 - c2[0]!);
    const arrow = (s: number) =>
      `M${x2 - ARROW * Math.cos(ang + s * 0.5)},${y2 - ARROW * Math.sin(ang + s * 0.5)} L${x2},${y2}`;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    return (
      <SVGContainer>
        <g className="rd-edge" data-rc="edge" data-role={role} data-dim={dim || undefined}>
          <path className="rd-edge-line" d={d} />
          {role === "derived" && <path className="rd-edge-line" d={`${arrow(1)} ${arrow(-1)}`} />}
          {role === "context" && (
            <>
              <circle className="rd-edge-dot" cx={x1} cy={y1} r={DOT} />
              <circle className="rd-edge-dot" cx={x2} cy={y2} r={DOT} />
            </>
          )}
          {shape.props.label && (
            <foreignObject x={mx - 40} y={my - 10} width={80} height={20}>
              <span className="rd-edge-label">{shape.props.label}</span>
            </foreignObject>
          )}
        </g>
      </SVGContainer>
    );
  }
}
