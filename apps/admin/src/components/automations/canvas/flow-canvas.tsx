'use client';

import '@xyflow/react/dist/style.css';

if (typeof globalThis.window !== 'undefined' && typeof globalThis.ResizeObserver === 'undefined') {
  class FallbackResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = FallbackResizeObserver;
}

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import type { FlowDefinition, FlowDraft, FlowIssue, FlowStepKind } from '@gt-sales/contracts';
import { Badge, cn } from '@gt-sales/ui';

import { issueText, type FlowNames } from '../flow-words';
import {
  ADD_BUTTON_SIZE,
  CARD_WIDTH,
  STEP_KIND_LABELS,
  layoutFlow,
  type AddStepNodeData,
  type FlowCanvasNode,
  type IfElseNodeData,
  type StepNodeData,
  type TriggerNodeData,
} from './layout-flow';

const ACTION_STEP_KINDS: readonly FlowStepKind[] = [
  'send_email',
  'create_task',
  'assign_lead',
  'update_lead',
  'notify_staff',
];

const FLOW_CONTROL_STEP_KINDS: readonly FlowStepKind[] = ['if_else', 'wait'];

interface CanvasContextValue {
  selectedId: string | undefined;
  openMenuId: string | undefined;
  setOpenMenuId(id: string | undefined): void;
  onSelectNode(id: string): void;
  onAddStep(sequencePath: string, index: number, kind: FlowStepKind): void;
}

const CanvasContext = createContext<CanvasContextValue>({
  selectedId: undefined,
  openMenuId: undefined,
  setOpenMenuId: () => undefined,
  onSelectNode: () => undefined,
  onAddStep: () => undefined,
});

function TriggerNode({ id, data }: NodeProps<FlowCanvasNode>): JSX.Element | null {
  const ctx = useContext(CanvasContext);
  if (data.kind !== 'trigger') return null;
  const triggerData: TriggerNodeData = data;
  const selected = ctx.selectedId === id;
  const hasIssue = triggerData.issues.length > 0;

  return (
    <div style={{ width: CARD_WIDTH }} className="relative">
      <button
        type="button"
        data-node-id={id}
        aria-label={`Trigger: ${triggerData.summary}`}
        aria-pressed={selected}
        onClick={() => ctx.onSelectNode(id)}
        className={cn(
          'nodrag nopan flex w-full flex-col gap-1 rounded-md border bg-card p-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary/50',
          hasIssue ? 'border-amber-400 dark:border-amber-700' : '',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            When
          </span>
          {hasIssue ? (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-[10px] text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              Needs attention
            </Badge>
          ) : triggerData.incomplete ? (
            <Badge variant="outline" className="text-[10px]">
              Incomplete
            </Badge>
          ) : null}
        </div>
        <p className="line-clamp-2 text-sm font-medium">{triggerData.summary}</p>
        {triggerData.whenSummary ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">{triggerData.whenSummary}</p>
        ) : null}
        {triggerData.issues[0] ? (
          <p className="line-clamp-1 text-xs text-amber-800 dark:text-amber-200">
            {issueText(triggerData.issues[0])}
          </p>
        ) : null}
      </button>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
    </div>
  );
}

function StepNode({ id, data }: NodeProps<FlowCanvasNode>): JSX.Element | null {
  const ctx = useContext(CanvasContext);
  if (data.kind !== 'step' && data.kind !== 'if_else') return null;
  const stepData: StepNodeData | IfElseNodeData = data;
  const selected = ctx.selectedId === id;
  const hasIssue = stepData.issues.length > 0;

  return (
    <div style={{ width: CARD_WIDTH }} className="relative">
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
      <button
        type="button"
        data-node-id={id}
        aria-label={`${stepData.kindLabel}: ${stepData.summary}`}
        aria-pressed={selected}
        onClick={() => ctx.onSelectNode(id)}
        className={cn(
          'nodrag nopan flex w-full flex-col gap-1 rounded-md border bg-card p-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary/50',
          hasIssue ? 'border-amber-400 dark:border-amber-700' : '',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {stepData.kindLabel}
          </span>
          {hasIssue ? (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-[10px] text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              Needs attention
            </Badge>
          ) : stepData.incomplete ? (
            <Badge variant="outline" className="text-[10px]">
              Incomplete
            </Badge>
          ) : null}
        </div>
        <p className="line-clamp-2 text-sm font-medium">{stepData.summary}</p>
        {stepData.issues[0] ? (
          <p className="line-clamp-1 text-xs text-amber-800 dark:text-amber-200">
            {issueText(stepData.issues[0])}
          </p>
        ) : null}
      </button>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
    </div>
  );
}

function AddStepNode({ id, data }: NodeProps<FlowCanvasNode>): JSX.Element | null {
  const ctx = useContext(CanvasContext);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isOpen = ctx.openMenuId === id;

  useEffect(() => {
    if (!isOpen) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not([disabled])',
    );
    firstItem?.focus();
  }, [isOpen]);

  if (data.kind !== 'add_step') return null;
  const addData: AddStepNodeData = data;

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      ctx.setOpenMenuId(undefined);
      buttonRef.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not([disabled])',
      ) ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + delta + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  function choose(kind: FlowStepKind) {
    ctx.setOpenMenuId(undefined);
    ctx.onAddStep(addData.sequencePath, addData.index, kind);
  }

  return (
    <div
      style={{ width: ADD_BUTTON_SIZE, height: ADD_BUTTON_SIZE }}
      className="relative flex items-center justify-center"
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
      {addData.branchLabel ? (
        <span className="pointer-events-none absolute -top-6 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
          {addData.branchLabel}
        </span>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        data-node-id={id}
        disabled={addData.disabled}
        aria-label={addData.label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={addData.disabled ? 'A flow has 30 steps at most' : addData.label}
        onClick={() => ctx.setOpenMenuId(isOpen ? undefined : id)}
        className="nodrag nopan flex size-8 items-center justify-center rounded-full border bg-background text-sm font-semibold shadow-sm transition-colors hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        +
      </button>

      {isOpen ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Add step"
          onKeyDown={handleMenuKeyDown}
          className="nodrag nopan absolute top-9 left-1/2 z-50 flex w-48 -translate-x-1/2 flex-col gap-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-md"
        >
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Actions
          </p>
          {ACTION_STEP_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => choose(kind)}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              {STEP_KIND_LABELS[kind]}
            </button>
          ))}
          <div className="my-0.5 border-t" />
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Flow
          </p>
          {FLOW_CONTROL_STEP_KINDS.map((kind) => {
            const disabled = kind === 'if_else' && !addData.canAddIfElse;
            return (
              <button
                key={kind}
                type="button"
                role="menuitem"
                disabled={disabled}
                title={disabled ? 'Branches go 3 deep at most' : undefined}
                onClick={() => choose(kind)}
                className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{STEP_KIND_LABELS[kind]}</span>
                {disabled ? (
                  <span className="text-[10px] text-muted-foreground">Max depth</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  trigger: TriggerNode,
  step: StepNode,
  if_else: StepNode,
  add_step: AddStepNode,
};

export function FlowCanvas({
  definition,
  issues = [],
  names,
  readOnly = false,
  selectedId,
  onSelectNode,
  onAddStep,
}: {
  definition: FlowDefinition | FlowDraft;
  issues?: readonly FlowIssue[];
  names: FlowNames;
  readOnly?: boolean;
  selectedId: string | undefined;
  onSelectNode(id: string): void;
  onAddStep(sequencePath: string, index: number, kind: FlowStepKind): void;
}): JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string>();

  const { nodes, edges } = useMemo(
    () => layoutFlow(definition, { issues, readOnly, names }),
    [definition, issues, readOnly, names],
  );

  const contextValue = useMemo<CanvasContextValue>(
    () => ({
      selectedId,
      openMenuId,
      setOpenMenuId,
      onSelectNode: (id: string) => {
        setOpenMenuId(undefined);
        onSelectNode(id);
      },
      onAddStep,
    }),
    [selectedId, openMenuId, onSelectNode, onAddStep],
  );

  return (
    <CanvasContext.Provider value={contextValue}>
      <div
        role="region"
        aria-label="Automation flow canvas"
        className="h-[38rem] w-full rounded-md border bg-muted/10"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          width={800}
          height={608}
          onlyRenderVisibleElements={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.25}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          onPaneClick={() => setOpenMenuId(undefined)}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  );
}

export default FlowCanvas;
