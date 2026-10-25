// platform/client/src/components/IttFlowchart.tsx
import { useState, useId } from 'react';
import {describeNode} from '../lib/execution-presentation';
import type {
  TraceLayout, TraceNode, TraceContainer, TraceEdge, CFGNode,
  NodeStatus,
} from '../lib/trace-layout';
import {
  NODE_W, NODE_H, H_GAP, CONTAINER_PADDING,
  ROW_H, CONTAINER_HEADER_H,
} from '../lib/trace-layout';

// Re-export for consumers that already import NodeStatus from here
export type { NodeStatus, CFGNode } from '../lib/trace-layout';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface IttFlowchartProps {
  layout: TraceLayout;
  showStatus?: boolean;
  onNodeClick?: (nodeId: string, nodeRunId: string | undefined, svgX: number, svgY: number, error?: string) => void;
}

// ── Colors ────────────────────────────────────────────────────────────────────

const SYS_TYPES = new Set(['assign', 'if', 'for', 'foreach']);

/** Executor-based colors for light mode — uses -200 fills for visible color on white */
function nodeColors(node: CFGNode, status: NodeStatus): {
  fill: string; stroke: string; text: string; strokeWidth: number; opacity: number
} {
  if (status === 'failed') return {fill:'#fff1f2',stroke:'#d56b7b',text:'#9f2340',strokeWidth:1.5,opacity:1};
  if (status === 'suspended') return {fill:'#fff8e8',stroke:'#d6a343',text:'#815809',strokeWidth:1.5,opacity:1};
  if (status === 'completed') return {fill:'#edf8f1',stroke:'#83b69a',text:'#245f40',strokeWidth:1.5,opacity:1};
  if (status === 'running') return {fill:'#edf4ff',stroke:'#6594cc',text:'#285a93',strokeWidth:1.5,opacity:1};
  const actor = node.executor === 'ai' ? ['#f4f0fc','#c5b5e3','#5d4883'] : node.executor === 'human' ? ['#fff8eb','#e0c995','#815e20'] : node.executor === 'code' ? ['#edf5fc','#b4cce1','#315e81'] : ['#fff','#c9d6da','#455766'];
  return {fill:actor[0],stroke:actor[1],text:actor[2],strokeWidth:1.2,opacity:1};
}

const EDGE_COLORS: Record<TraceEdge['kind'], string> = {
  next:       '#94a3b8',
  next_true:  '#82969e',
  next_false: '#82969e',
  next_exit:  '#94a3b8',
  next_body: '#94a3b8',
};

// ── Arrow ─────────────────────────────────────────────────────────────────────

function Arrow({ from, to, color, label, laneOffset = 0, dimmed = false, sideExit = false }: {
  from: { x: number; y: number };
  to:   { x: number; y: number };
  color: string;
  label?: string;
  laneOffset?: number;
  dimmed?: boolean;
  sideExit?: boolean;
}) {
  const actualColor = dimmed ? '#9ca3af' : color;
  const mid = (from.y + to.y) / 2;
  const markerId = useId().replace(/:/g, '');
  const backwards = to.y <= from.y;
  const detour = sideExit || backwards || to.y - from.y > 100;
  const lane = Math.max(from.x,to.x)+170+laneOffset;
  const path = sideExit
    ? `M${from.x},${from.y} L${lane-12},${from.y} Q${lane},${from.y} ${lane},${from.y+12} L${lane},${to.y-24} Q${lane},${to.y-12} ${lane-12},${to.y-12} L${to.x+12},${to.y-12} Q${to.x},${to.y-12} ${to.x},${to.y}`
    : detour
    ? `M${from.x},${from.y} L${from.x},${from.y+12} Q${from.x},${from.y+24} ${from.x+12},${from.y+24} L${lane-12},${from.y+24} Q${lane},${from.y+24} ${lane},${from.y+36} L${lane},${to.y-36} Q${lane},${to.y-24} ${lane-12},${to.y-24} L${to.x+12},${to.y-24} Q${to.x},${to.y-24} ${to.x},${to.y-12} L${to.x},${to.y}`
    : `M${from.x},${from.y} C${from.x},${mid} ${to.x},${mid} ${to.x},${to.y}`;

  return (
    <>
      <defs>
        <marker id={markerId} markerWidth={6} markerHeight={6} refX={3} refY={3} orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill={actualColor} />
        </marker>
      </defs>
      <path
        d={path}
        fill="none"
        stroke={actualColor}
        strokeWidth={1.5}
        strokeDasharray={dimmed ? '4 2' : undefined}
        markerEnd={`url(#${markerId})`}
      />
      {label && <text x={detour ? lane-8 : (from.x+to.x)/2+12} y={mid} fill="#60717b" fontSize={11} paintOrder="stroke" stroke="#fbfcfd" strokeWidth={4} strokeLinejoin="round">{label}</text>}
    </>
  );
}

// ── NodeShape ─────────────────────────────────────────────────────────────────

const ERROR_LABEL_H = 14; // extra height reserved below a failed node for the error snippet

function NodeShape({ node, x, y, w, h, status, error, dimmed = false, showStatus = false, routed = false, onClick }: {
  node: CFGNode;
  x: number; y: number;
  w: number; h: number;
  status: NodeStatus;
  error?: string;
  dimmed?: boolean;
  showStatus?: boolean;
  routed?: boolean;
  onClick?: () => void;
}) {
  const colors = nodeColors(node, status);
  const cx = x + w / 2;
  const cy = y + h / 2;
  // Issue 5: strip call_ prefix; show only executor (or node type for sys nodes)
  const displayId = describeNode(node).title;
  const maxChars = Math.floor((w-24)/7.5);
  const label = displayId.length > maxChars ? displayId.slice(0,maxChars-1)+'…' : displayId;
  const actor = node.executor === 'ai' ? 'AI' : node.executor === 'human' ? 'Human' : node.executor === 'code' ? 'Code' : node.type === 'call' ? 'Workflow' : node.type === 'end' ? '' : 'Control';
  const typeLabel = actor + (status !== 'pending' ? ` · ${status === 'suspended' ? 'Paused' : status}` : showStatus && node.type !== 'end' ? ' · Not run' : '');
  const errorSnippet = error ? (error.length > 28 ? error.slice(0, 27) + '…' : error) : undefined;
  const interaction = onClick ? {
    role: 'button', tabIndex: 0,
    'aria-label': `${displayId}. ${typeLabel}. Open step details`,
    onClick: (event: React.MouseEvent<SVGGElement>) => { event.currentTarget.focus(); onClick(); },
    onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); }
    },
  } : {};

  if (node.type === 'if' && !routed) {
    const hw = w / 2;
    const hh = h / 2 + 4;
    return (
      <g {...interaction} style={{ cursor: onClick ? 'pointer' : undefined }} opacity={dimmed ? 0.65 : colors.opacity}>
        <title>{displayId}</title><polygon
          points={`${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`}
          fill={colors.fill} stroke={colors.stroke} strokeWidth={colors.strokeWidth}
        />
        <text x={cx} y={cy - 5}  textAnchor="middle" fill={colors.text}   fontSize={13} fontFamily="inherit">{label}</text>
        <text x={cx} y={cy + 16}  textAnchor="middle" fill="#60717b" fontSize={11} fontFamily="inherit">{typeLabel}</text>
        {errorSnippet && <text x={cx} y={cy + hh + ERROR_LABEL_H} textAnchor="middle" fill="#f87171" fontSize={8} fontFamily="monospace">⚠ {errorSnippet}</text>}
      </g>
    );
  }

  return (
    <g {...interaction} style={{ cursor: onClick ? 'pointer' : undefined }} opacity={dimmed ? 0.65 : colors.opacity}>
      <title>{displayId}</title><rect x={x} y={y} width={w} height={h} rx={8} fill={colors.fill} stroke={colors.stroke} strokeWidth={colors.strokeWidth} />
      {(node.type === 'for' || node.type === 'foreach') && (
        <rect x={x + 2} y={y + 2} width={w - 4} height={h - 4} rx={3} fill="none" stroke={colors.stroke} strokeWidth={0.5} />
      )}
      <text x={cx} y={cy - 5} textAnchor="middle" fill={colors.text}   fontSize={13} fontFamily="inherit">{node.type==='if'?'◇ ':''}{label}</text>
      <text x={cx} y={cy + 16} textAnchor="middle" fill="#60717b" fontSize={11} fontFamily="inherit">{typeLabel}</text>
      {errorSnippet && <text x={cx} y={y + h + ERROR_LABEL_H} textAnchor="middle" fill="#f87171" fontSize={8} fontFamily="monospace">⚠ {errorSnippet}</text>}
    </g>
  );
}

// ── TraceContainerShape ───────────────────────────────────────────────────────

function TraceContainerShape({ container, onNodeClick }: {
  container: TraceContainer;
  onNodeClick?: (nodeId: string, nodeRunId: string | undefined, svgX: number, svgY: number, error?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(container.collapsed);
  const displayH = collapsed ? CONTAINER_HEADER_H : container.h;
  const ROW_LABEL_W = 18; // space reserved for [1], [2], etc.

  return (
    <g>
      {/* Dashed border */}
      <rect
        x={container.x} y={container.y}
        width={container.w} height={displayH}
        rx={6}
        fill="#f8fafc"
        stroke="#cbd5e1"
        strokeWidth={1}
        strokeDasharray="4 2"
      />
      {/* Header (click to toggle collapse) */}
      <g role="button" tabIndex={0} aria-label={`${container.label}: ${container.iterationCount} iterations`} aria-expanded={!collapsed}
        onClick={() => setCollapsed(c => !c)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCollapsed(c => !c); } }}
        style={{ cursor: 'pointer' }}>
        <rect
          x={container.x} y={container.y}
          width={container.w} height={CONTAINER_HEADER_H}
          rx={4} fill="#f1f5f9"
        />
        <text x={container.x + 8} y={container.y + 14}
          fill="#6366f1" fontSize={9} fontFamily="monospace">{container.label}</text>
        <text x={container.x + 8} y={container.y + 25}
          fill="#3b82f6" fontSize={7}>
          {collapsed
            ? `▶ ${container.iterationCount} iterations ›`
            : `▼ ${container.iterationCount} iterations`}
        </text>
      </g>
      {/* Rows (hidden when collapsed) */}
      {!collapsed && container.rows.map((row, iterIdx) => {
        const rowBaseY = container.y + CONTAINER_HEADER_H + iterIdx * ROW_H;
        return (
          <g key={iterIdx}>
            {/* Row index label */}
            <text
              x={container.x + 4}
              y={rowBaseY + NODE_H / 2 + 5}
              fill="#475569" fontSize={7}
            >[{iterIdx + 1}]</text>
            {/* Body nodes */}
            {row.map(traceNode => {
              const nx = container.x + CONTAINER_PADDING + ROW_LABEL_W + traceNode.x;
              const ny = rowBaseY + 2;
              return (
                <NodeShape
                  key={`${traceNode.id}-${iterIdx}`}
                  node={traceNode.cfg}
                  x={nx} y={ny}
                  w={traceNode.w} h={traceNode.h}
                  status={traceNode.status}
                  error={traceNode.error}
                  dimmed={traceNode.dimmed}
                  onClick={traceNode.nodeRunId && onNodeClick ? () => onNodeClick(
                    traceNode.id,
                    traceNode.nodeRunId,
                    nx + traceNode.w,       // right edge of node (anchor for popup)
                    ny + traceNode.h / 2,   // vertical center
                    traceNode.error,
                  ) : undefined}
                />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IttFlowchart({ layout, onNodeClick, showStatus }: IttFlowchartProps) {
  const routedMarker=useId().replace(/:/g,'');
  const itemMap = new Map(layout.items.map(item => [item.id, item]));

  const getBottom = (id: string): { x: number; y: number } | null => {
    const item = itemMap.get(id);
    return item ? { x: item.x + item.w / 2, y: item.y + item.h } : null;
  };
  const getTop = (id: string): { x: number; y: number } | null => {
    const item = itemMap.get(id);
    return item ? { x: item.x + item.w / 2, y: item.y } : null;
  };

  return (
    <div className="workflow-drawing">
      <svg role="group" aria-label="Workflow steps and connections" width={layout.routed?layout.width:layout.width+100+layout.edges.length*14} height={layout.height} style={{ minWidth: layout.routed?layout.width:layout.width+100+layout.edges.length*14, marginInline: 'auto' }}>
        <defs><marker id={routedMarker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#7c8f9f" /></marker></defs>
        {/* Edges */}
        {layout.edges.map((edge, i) => {
          if(layout.routed && edge.points) return <g key={i}>
            <path d={edge.points.map((point,j)=>`${j?'L':'M'}${point.x},${point.y}`).join(' ')} fill="none" stroke="#7c8f9f" strokeWidth="1.5" strokeLinejoin="round" markerEnd={`url(#${routedMarker})`} />
            {edge.label&&<g><rect x={edge.label.x} y={edge.label.y} width={edge.label.width} height={edge.label.height} rx="4" fill="#f0f4f8" /><text x={edge.label.x+edge.label.width/2} y={edge.label.y+15} textAnchor="middle" fill="#4b6478" fontSize="12">{edge.label.text}</text></g>}
          </g>;
          const source=itemMap.get(edge.from);
          const sideExit=source?.cfg.type==='if' && edge.kind==='next_false';
          const from=sideExit && source ? {x:source.x+source.w,y:source.y+source.h/2} : getBottom(edge.from);
          if(from && source?.cfg.type==='if' && !sideExit) from.y+=4;
          const to   = getTop(edge.to);
          if (!from || !to) return null;
          return (
            <Arrow
              key={i}
              from={from}
              to={to}
              color={EDGE_COLORS[edge.kind]}
              laneOffset={i*14}
              sideExit={sideExit}
              label={edge.kind === 'next_true' ? 'true' : edge.kind === 'next_false' ? 'false' : edge.kind === 'next_body' ? 'repeat' : edge.kind === 'next_exit' ? 'exit' : undefined}
              dimmed={edge.dimmed}
            />
          );
        })}
        {/* Items */}
        {layout.items.map(item => {
          if (item.kind === 'container') {
            return (
              <TraceContainerShape
                key={item.id}
                container={item}
                onNodeClick={onNodeClick}
              />
            );
          }
          return (
            <NodeShape
              key={item.id}
              routed={layout.routed}
              showStatus={showStatus}
              node={item.cfg}
              x={item.x} y={item.y}
              w={item.w} h={item.h}
              status={item.status}
              error={item.error}
              dimmed={item.dimmed}
              onClick={onNodeClick && item.cfg.type !== 'end' ? () => onNodeClick(
                item.id,
                item.nodeRunId,
                item.x + item.w,
                item.y + item.h / 2,
                item.error,
              ) : undefined}
            />
          );
        })}
      </svg>
    </div>
  );
}
