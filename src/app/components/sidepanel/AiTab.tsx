import { Button, TextArea, Toast, Tooltip } from '@douyinfe/semi-ui';
import { IconCopy, IconImport, IconTerminal } from '@douyinfe/semi-icons';
import { useState } from 'react';
import { standalonePrompt } from '../../../core/ai/prompt';
import { useActions } from '../../hooks/useActions';
import { useDocumentStore } from '../../store/documentStore';
import { downloadText } from '../../utils/files';

export function AiTab() {
  const doc = useDocumentStore((s) => s.doc);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const actions = useActions();
  const [instruction, setInstruction] = useState('');
  const [refine, setRefine] = useState(false);
  const [pasted, setPasted] = useState('');

  const copyPrompt = async () => {
    const text = standalonePrompt(instruction.trim() || 'Describe aquí el sistema.', refine ? doc : undefined);
    try {
      await navigator.clipboard.writeText(text);
      Toast.success('Prompt copiado. Pégalo en Claude, ChatGPT o tu agente y trae de vuelta el JSON.');
    } catch {
      Toast.warning('No se pudo acceder al portapapeles; el prompt se descargará como archivo.');
      downloadText('prompt-c4.txt', text, 'text/plain');
    }
  };

  const cliCommand = `npx c4diagram generate "${(instruction.trim() || 'Describe aquí el sistema').replace(/"/g, '\\"')}" --out diagrama.drawio --json diagrama.json`;

  return (
    <div className="p-3 space-y-3 text-sm">
      <div>
        <div className="font-medium mb-1">1. Describe el sistema</div>
        <TextArea
          autosize={{ minRows: 4, maxRows: 10 }}
          value={instruction}
          onChange={setInstruction}
          placeholder="Ej.: Sistema de banca en línea con una app web (React), una API (Node.js), una base de datos PostgreSQL y una pasarela de pagos externa. Los clientes consultan saldos y hacen pagos…"
        />
        <label className="flex items-center gap-2 mt-2 text-xs text-color-2 cursor-pointer select-none">
          <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} />
          Refinar el diagrama actual en lugar de crear uno nuevo
        </label>
      </div>
      <div>
        <div className="font-medium mb-1">2. Genera el modelo con una IA</div>
        <p className="text-xs text-color-2 mb-2">
          La app no envía nada a ningún servicio: copia el prompt (incluye el esquema JSON) y úsalo con cualquier asistente, o ejecuta el CLI con tu clave de Anthropic.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Button icon={<IconCopy />} theme="solid" onClick={copyPrompt}>
            Copiar prompt para IA
          </Button>
          <Tooltip content={cliCommand}>
            <Button
              icon={<IconTerminal />}
              onClick={async () => {
                await navigator.clipboard.writeText(cliCommand).catch(() => undefined);
                Toast.info('Comando del CLI copiado');
              }}
            >
              Copiar comando CLI
            </Button>
          </Tooltip>
        </div>
      </div>
      <div>
        <div className="font-medium mb-1">3. Pega el JSON generado</div>
        <p className="text-xs text-color-2 mb-2">Se valida, se aplica autolayout automáticamente y se carga en el lienzo.</p>
        <TextArea autosize={{ minRows: 4, maxRows: 12 }} value={pasted} onChange={setPasted} placeholder='{"workspace": {...}, "elements": [...], ...}' className="font-mono text-xs" disabled={readOnly} />
        <div className="flex gap-2 mt-2">
          <Button
            icon={<IconImport />}
            theme="solid"
            disabled={readOnly || !pasted.trim()}
            onClick={() => {
              if (actions.importJsonText(pasted, refine ? 'merge' : 'replace')) {
                setPasted('');
                Toast.success(refine ? 'Modelo fusionado' : 'Modelo cargado');
              }
            }}
          >
            {refine ? 'Fusionar en el diagrama' : 'Cargar como nuevo diagrama'}
          </Button>
        </div>
      </div>
    </div>
  );
}
