import { Modal } from '@douyinfe/semi-ui';

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl/⌘ + Z', 'Deshacer'],
  ['Ctrl/⌘ + Y · Ctrl/⌘ + Shift + Z', 'Rehacer'],
  ['Ctrl/⌘ + S', 'Guardar JSON (o Guardar en modo embebido)'],
  ['Ctrl/⌘ + E', 'Exportar .drawio'],
  ['Ctrl/⌘ + O', 'Abrir JSON'],
  ['Ctrl/⌘ + L', 'Autolayout de la vista activa'],
  ['Supr / Retroceso', 'Quitar de la vista el elemento seleccionado (o borrar la relación)'],
  ['Ctrl/⌘ + rueda', 'Zoom'],
  ['Rueda / Shift + rueda', 'Desplazar vertical / horizontal'],
  ['Botón central o derecho + arrastrar', 'Desplazar el lienzo'],
  ['Arrastrar desde un punto de conexión', 'Crear una relación'],
];

export function ShortcutsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal title="Atajos de teclado" visible={visible} onCancel={onClose} footer={null} size="small">
      <table className="w-full text-sm">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k} className="border-b border-color">
              <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap">{k}</td>
              <td className="py-1.5 text-color-2">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function AboutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal title="Diagramador C4" visible={visible} onCancel={onClose} footer={null} size="small">
      <div className="space-y-2 text-sm">
        <p>Editor de diagramas del modelo C4 (Contexto, Contenedores, Componentes) con autolayout, exportación a draw.io y generación asistida por IA.</p>
        <ul className="list-disc pl-5 text-color-2">
          <li>El documento se guarda como JSON limpio, convertible 1‑a‑1 a <code>.drawio</code>.</li>
          <li>
            El mismo motor funciona como CLI: <code>npx c4diagram generate "…"</code>, <code>layout</code>, <code>convert</code>.
          </li>
          <li>
            Se puede embeber en otra aplicación por iframe con <code>?embed=1&amp;proto=json</code> y postMessage.
          </li>
        </ul>
      </div>
    </Modal>
  );
}
