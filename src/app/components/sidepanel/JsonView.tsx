import { Button, Toast } from '@douyinfe/semi-ui';
import { IconCopy, IconDownload } from '@douyinfe/semi-icons';
import { useMemo } from 'react';
import { useActions } from '../../hooks/useActions';
import { useDocumentStore } from '../../store/documentStore';

export function JsonView() {
  const doc = useDocumentStore((s) => s.doc);
  const actions = useActions();
  const text = useMemo(() => JSON.stringify(doc, null, 2), [doc]);
  return (
    <div className="p-3 h-full flex flex-col gap-2">
      <div className="flex gap-2">
        <Button
          size="small"
          icon={<IconCopy />}
          onClick={async () => {
            await navigator.clipboard.writeText(text).catch(() => undefined);
            Toast.success('JSON copiado');
          }}
        >
          Copiar
        </Button>
        <Button size="small" icon={<IconDownload />} onClick={actions.saveJson}>
          Descargar
        </Button>
        <span className="text-xs text-color-3 self-center">Formato convertible 1‑a‑1 a .drawio</span>
      </div>
      <pre className="flex-1 overflow-auto text-xs font-mono card-theme rounded-md p-2 whitespace-pre">{text}</pre>
    </div>
  );
}
