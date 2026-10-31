import type { CSSProperties } from 'react';
import AgentRenderingSurface from '../../kios/AgentRenderingSurface';
import type { AgentHtmlBlock } from './agent-nachrichten-typen';

export function NativeHtmlBlock({ block, project }: { block: AgentHtmlBlock; project?: string }) {
  const style = {
    '--block-column': String(block.column),
    '--block-column-span': String(block.columnSpan),
    '--block-row': String(block.row),
    '--block-row-span': String(block.rowSpan),
    '--block-min-height': block.minHeight + 'px',
  } as CSSProperties;

  return (
    <AgentRenderingSurface
      html={block.html}
      revision={block.revision ?? block.html}
      interactive={block.interactive}
      className="native-html-block"
      style={style}
      verweisProjekt={project}
      zitatMenue
    />
  );
}
