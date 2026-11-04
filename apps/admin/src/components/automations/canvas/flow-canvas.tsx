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

import { createContext, useContext, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  type ReactFlowInstance,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import type { FlowDefinition, FlowDraft, FlowIssue, FlowStepKind } from '@gt-sales/contracts';
import {
  ZapIcon,
  MailIcon,
  ListTodoIcon,
  UserRoundIcon,
  PencilIcon,
  BellIcon,
  GitBranchIcon,
  ClockIcon,
  FlagIcon,
} from 'lucide-react';
import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@gt-sales/ui';

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

const STEP_ICONS = {
  send_email: MailIcon,
  create_task: ListTodoIcon,
  assign_lead: UserRoundIcon,
  update_lead: PencilIcon,
  notify_staff: BellIcon,
  if_else: GitBranchIcon,
  wait: ClockIcon,
};

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
          'automation-node-card nodrag nopan flex h-[116px] w-full flex-col gap-1.5 overflow-hidden rounded-lg border bg-card p-3 text-left shadow-sm transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary/50',
          hasIssue ? 'border-amber-400 dark:border-amber-700' : '',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <ZapIcon className="size-4" aria-hidden="true" /> Trigger
            </span>
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
        <p
          className={cn(
            'text-sm font-medium',
            hasIssue && triggerData.whenSummary ? 'line-clamp-1' : 'line-clamp-2',
          )}
        >
          {triggerData.summary}
        </p>
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
  const Icon = STEP_ICONS[stepData.step.kind];
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
          'automation-node-card nodrag nopan flex h-[116px] w-full flex-col gap-1.5 overflow-hidden rounded-lg border bg-card p-3 text-left shadow-sm transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary/50',
          hasIssue ? 'border-amber-400 dark:border-amber-700' : '',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Icon className="size-4" aria-hidden="true" />
              {stepData.kindLabel}
            </span>
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
      {stepData.kind === 'if_else' ? (
        <>
          <Handle
            id="yes"
            type="source"
            position={Position.Bottom}
            isConnectable={false}
            style={{ left: '25%' }}
            className="!pointer-events-none !opacity-0"
          />
          <Handle
            id="no"
            type="source"
            position={Position.Bottom}
            isConnectable={false}
            style={{ left: '75%' }}
            className="!pointer-events-none !opacity-0"
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          className="!pointer-events-none !opacity-0"
        />
      )}
    </div>
  );
}

const STEP_HELP: Record<FlowStepKind, string> = {
  send_email: 'Use a Site email template',
  create_task: 'Create a staff follow-up',
  assign_lead: 'Set the lead owner',
  update_lead: 'Change a field or stage',
  notify_staff: 'Email your team',
  if_else: 'Choose a Yes or No path',
  wait: 'Pause before the next action',
};

function AddStepNode({ id, data }: NodeProps<FlowCanvasNode>): JSX.Element | null {
  const ctx = useContext(CanvasContext);
  const choseStep = useRef(false);
  if (data.kind !== 'add_step') return null;
  const addData: AddStepNodeData = data;
  function choose(kind: FlowStepKind) {
    choseStep.current = true;
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
      <DropdownMenu
        open={ctx.openMenuId === id}
        onOpenChange={(open) => {
          if (open) choseStep.current = false;
          ctx.setOpenMenuId(open ? id : undefined);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-node-id={id}
            disabled={addData.disabled}
            aria-label={addData.label}
            title={addData.disabled ? 'A flow has 30 steps at most' : addData.label}
            className="nodrag nopan flex size-8 items-center justify-center rounded-full border bg-background text-sm font-semibold shadow-sm transition-colors hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            +
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          onCloseAutoFocus={(event) => {
            if (choseStep.current) event.preventDefault();
          }}
          aria-label="Add step"
          aria-labelledby={undefined}
          sideOffset={8}
          collisionPadding={12}
          className="nodrag nopan max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto"
        >
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          {ACTION_STEP_KINDS.map((kind) => (
            <DropdownMenuItem
              key={kind}
              aria-label={STEP_KIND_LABELS[kind]}
              onSelect={() => choose(kind)}
            >
              <span>
                <span className="block font-medium">{STEP_KIND_LABELS[kind]}</span>
                <span className="block text-xs text-muted-foreground">{STEP_HELP[kind]}</span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Flow</DropdownMenuLabel>
          {FLOW_CONTROL_STEP_KINDS.map((kind) => (
            <DropdownMenuItem
              key={kind}
              aria-label={STEP_KIND_LABELS[kind]}
              disabled={kind === 'if_else' && !addData.canAddIfElse}
              onSelect={() => choose(kind)}
            >
              <span>
                <span className="block font-medium">{STEP_KIND_LABELS[kind]}</span>
                <span className="block text-xs text-muted-foreground">
                  {kind === 'if_else' && !addData.canAddIfElse
                    ? 'Branches go 3 deep at most'
                    : STEP_HELP[kind]}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
    </div>
  );
}

function EndNode({ data }: NodeProps<FlowCanvasNode>) {
  if (data.kind !== 'end') return null;
  return (
    <div className="flex h-9 w-[180px] items-center justify-center gap-2 rounded-full border border-dashed bg-background text-xs text-muted-foreground">
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!pointer-events-none !opacity-0"
      />
      <FlagIcon className="size-3" aria-hidden="true" />
      {data.label}
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  end: EndNode,
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
  const [instance, setInstance] = useState<ReactFlowInstance<FlowCanvasNode>>();
  const motionDuration = () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 280;

  const { nodes, edges } = useMemo(() => {
    const layout = layoutFlow(definition, { issues, readOnly, names });
    return {
      ...layout,
      // React Flow transforms each node into its own stacking context.
      // Lift the open menu's node above later cards, not just its children.
      nodes: layout.nodes.map((node): FlowCanvasNode => ({
        ...node,
        zIndex: node.id === openMenuId ? 1000 : 0,
        // Fixed, non-selectable nodes still contain interactive buttons.
        // React Flow otherwise disables pointer events on their wrappers.
        style: { ...node.style, pointerEvents: 'all' },
        className: node.id === selectedId ? 'automation-node-selected' : undefined,
      })),
    };
  }, [definition, issues, readOnly, names, openMenuId, selectedId]);

  useEffect(() => {
    if (!instance || !selectedId) return;
    const timer = window.setTimeout(() => {
      void instance.fitView({
        nodes: [{ id: selectedId }],
        padding: 0.5,
        minZoom: 0.65,
        maxZoom: 0.9,
        duration: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 280,
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [instance, selectedId]);

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
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p className="text-muted-foreground">
            Follow the arrows. Select a card to see its settings.
          </p>
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void instance?.fitView({
                  nodes,
                  padding: 0.2,
                  minZoom: 0.25,
                  maxZoom: 1,
                  duration: motionDuration(),
                })
              }
            >
              Fit flow
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!selectedId || !instance}
              onClick={() => {
                const node = nodes.find((node) => node.id === selectedId);
                if (node)
                  void instance?.fitView({
                    nodes: [node],
                    maxZoom: 1,
                    padding: 0.5,
                    duration: motionDuration(),
                  });
              }}
            >
              Focus selected
            </Button>
          </div>
        </div>
        <div
          role="region"
          aria-label="Automation flow canvas"
          className="automation-canvas h-[34rem] w-full overflow-hidden rounded-lg border bg-muted/10 sm:h-[40rem]"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onInit={setInstance}
            onlyRenderVisibleElements={false}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
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
            {nodes.filter((node) => node.data.kind === 'step' || node.data.kind === 'if_else')
              .length > 8 ? (
              <MiniMap
                pannable
                zoomable
                className="!hidden sm:!block"
                ariaLabel="Flow overview map"
              />
            ) : null}
            <Controls
              showInteractive={false}
              className="[&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground [&>button:hover]:!bg-accent"
            />
          </ReactFlow>
        </div>
      </div>
    </CanvasContext.Provider>
  );
}

export default FlowCanvas;
