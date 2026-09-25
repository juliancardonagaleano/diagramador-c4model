import { Button, Dropdown, Input, Modal, Tag, Tooltip } from '@douyinfe/semi-ui';
import { IconDownload, IconEdit, IconExit, IconSave } from '@douyinfe/semi-icons';
import { useEffect, useState } from 'react';
import { useActions } from '../../hooks/useActions';
import { isEmbedMode, useDocumentStore, useTemporalStore } from '../../store/documentStore';
import { relativeTime } from '../../utils/files';
import { AboutModal, ShortcutsModal } from './HelpModals';
import { DIRECTIONS, DISTRIBUTIONS } from './FloatingToolbar';

const Logo = () => (
  <div className="flex items-center gap-2 select-none">
    <div className="h-8 w-8 rounded-md flex items-center justify-center text-white font-bold text-sm" style={{ backgroundColor: 'var(--c4-primary)' }}>
      C4
    </div>
  </div>
);

interface MenuProps {
  label: string;
  items: Array<{ key: string; label: string; onClick?: () => void; disabled?: boolean; divider?: boolean; checked?: boolean; shortcut?: string }>;
}

function Menu({ label, items }: MenuProps) {
  return (
    <Dropdown
      trigger="click"
      position="bottomLeft"
      render={
        <Dropdown.Menu>
          {items.map((it) =>
            it.divider ? (
              <Dropdown.Divider key={it.key} />
            ) : (
              <Dropdown.Item key={it.key} onClick={it.onClick} disabled={it.disabled}>
                <div className="flex items-center justify-between gap-6 w-full min-w-[220px]">
                  <span>
                    {it.checked !== undefined && <span className="inline-block w-4">{it.checked ? '✓' : ''}</span>}
                    {it.label}
                  </span>
                  {it.shortcut && <span className="text-xs text-color-3">{it.shortcut}</span>}
                </div>
              </Dropdown.Item>
            ),
          )}
        </Dropdown.Menu>
      }
    >
      <div className="c4-menu-item hover-2">{label}</div>
    </Dropdown>
  );
}

export interface ControlPanelProps {
  /** Callbacks del modo embebido. */
  onEmbedSave?: (exit: boolean) => void;
  onEmbedExit?: () => void;
}

export function ControlPanel({ onEmbedSave, onEmbedExit }: ControlPanelProps) {
  const name = useDocumentStore((s) => s.doc.workspace.name);
  const setWorkspaceName = useDocumentStore((s) => s.setWorkspaceName);
  const ui = useDocumentStore((s) => s.ui);
  const setUi = useDocumentStore((s) => s.setUi);
  const modified = useDocumentStore((s) => s.modified);
  const lastSavedAt = useDocumentStore((s) => s.lastSavedAt);
  const statusMessage = useDocumentStore((s) => s.statusMessage);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const newDocument = useDocumentStore((s) => s.newDocument);
  const loadSample = useDocumentStore((s) => s.loadSample);
  const selection = useDocumentStore((s) => s.selection);
  const pastStates = useTemporalStore((t) => t.pastStates.length);
  const futureStates = useTemporalStore((t) => t.futureStates.length);
  const actions = useActions();
  const [editingTitle, setEditingTitle] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);

  // Descartar el documento actual (Nuevo/Cargar ejemplo/Abrir JSON) sin guardar antes pide
  // confirmación, igual que ya hace `useEmbedBridge.exit()` cuando hay cambios sin guardar.
  const confirmDiscard = (proceed: () => void) => {
    if (!modified) {
      proceed();
      return;
    }
    Modal.confirm({
      title: 'Descartar cambios sin guardar',
      content: 'Hay cambios sin guardar en el diagrama actual. ¿Deseas continuar de todos modos?',
      okText: 'Continuar',
      cancelText: 'Cancelar',
      okType: 'danger',
      onOk: proceed,
    });
  };

  const fileMenu: MenuProps['items'] = isEmbedMode
    ? [
        { key: 'save', label: 'Guardar', onClick: () => onEmbedSave?.(false), shortcut: 'Ctrl+S' },
        { key: 'save-exit', label: 'Guardar y salir', onClick: () => onEmbedSave?.(true) },
        { key: 'd1', label: '', divider: true },
        { key: 'export', label: 'Exportar .drawio (notación C4)…', onClick: () => void actions.exportDrawio('c4') },
        { key: 'export-card', label: 'Exportar .drawio (tarjetas)…', onClick: () => void actions.exportDrawio('card') },
        { key: 'json', label: 'Descargar JSON…', onClick: actions.saveJson },
        { key: 'd2', label: '', divider: true },
        { key: 'exit', label: 'Salir sin guardar', onClick: onEmbedExit },
      ]
    : [
        { key: 'new', label: 'Nuevo diagrama', onClick: () => confirmDiscard(newDocument) },
        { key: 'sample', label: 'Cargar ejemplo (banca en línea)', onClick: () => confirmDiscard(loadSample) },
        { key: 'open', label: 'Abrir JSON…', onClick: () => confirmDiscard(actions.openJson), shortcut: 'Ctrl+O' },
        { key: 'd1', label: '', divider: true },
        { key: 'save', label: 'Guardar JSON', onClick: actions.saveJson, shortcut: 'Ctrl+S' },
        { key: 'export', label: 'Exportar .drawio (notación C4)', onClick: () => void actions.exportDrawio('c4'), shortcut: 'Ctrl+E' },
        { key: 'export-card', label: 'Exportar .drawio (tarjetas)', onClick: () => void actions.exportDrawio('card') },
      ];

  const editMenu: MenuProps['items'] = [
    { key: 'undo', label: 'Deshacer', onClick: actions.undo, disabled: pastStates === 0 || readOnly, shortcut: 'Ctrl+Z' },
    { key: 'redo', label: 'Rehacer', onClick: actions.redo, disabled: futureStates === 0 || readOnly, shortcut: 'Ctrl+Y' },
    { key: 'd1', label: '', divider: true },
    { key: 'delete', label: 'Eliminar selección', onClick: actions.deleteSelection, disabled: selection.kind === 'none' || readOnly, shortcut: 'Supr' },
    { key: 'd2', label: '', divider: true },
    { key: 'layout', label: 'Autolayout de la vista', onClick: () => void actions.autoLayout(), disabled: readOnly, shortcut: 'Ctrl+L' },
  ];

  const viewMenu: MenuProps['items'] = [
    { key: 'header', label: 'Cabecera', checked: ui.showHeader, onClick: () => setUi({ showHeader: !ui.showHeader }) },
    { key: 'sidebar', label: 'Panel lateral', checked: ui.showSidebar, onClick: () => setUi({ showSidebar: !ui.showSidebar }) },
    { key: 'issues', label: 'Panel de problemas', checked: ui.showIssues, onClick: () => setUi({ showIssues: !ui.showIssues }) },
    { key: 'd1', label: '', divider: true },
    { key: 'grid', label: 'Cuadrícula', checked: ui.showGrid, onClick: () => setUi({ showGrid: !ui.showGrid }) },
    { key: 'minimap', label: 'Minimapa', checked: ui.showMinimap, onClick: () => setUi({ showMinimap: !ui.showMinimap }) },
    { key: 'd2', label: '', divider: true },
    { key: 'theme', label: 'Tema oscuro', checked: ui.theme === 'dark', onClick: () => setUi({ theme: ui.theme === 'dark' ? 'light' : 'dark' }) },
    { key: 'd3', label: '', divider: true },
    { key: 'style-c4', label: 'Notación C4 clásica', checked: ui.nodeStyle === 'c4', onClick: () => setUi({ nodeStyle: 'c4' }) },
    { key: 'style-card', label: 'Tarjetas (estilo drawdb)', checked: ui.nodeStyle === 'card', onClick: () => setUi({ nodeStyle: 'card' }) },
  ];

  const settingsMenu: MenuProps['items'] = [
    ...DIRECTIONS.map((d) => ({
      key: `dir-${d.value}`,
      label: `Dirección del autolayout: ${d.label}`,
      checked: ui.direction === d.value,
      onClick: () => setUi({ direction: d.value }),
    })),
    { key: 'd0', label: '', divider: true },
    ...DISTRIBUTIONS.map((d) => ({
      key: `dist-${d.value}`,
      label: d.label,
      checked: ui.distribution === d.value,
      onClick: () => setUi({ distribution: d.value }),
    })),
    { key: 'd1', label: '', divider: true },
    ...(['auto', 'compact', 'spacious'] as const).map((d) => ({
      key: `density-${d}`,
      label: `Densidad del autolayout: ${d === 'auto' ? 'automática (según relaciones)' : d === 'compact' ? 'compacta' : 'amplia'}`,
      checked: ui.density === d,
      onClick: () => setUi({ density: d }),
    })),
  ];

  const helpMenu: MenuProps['items'] = [
    { key: 'shortcuts', label: 'Atajos de teclado', onClick: () => setShowShortcuts(true) },
    { key: 'about', label: 'Acerca del diagramador', onClick: () => setShowAbout(true) },
    { key: 'c4', label: 'Modelo C4 (c4model.com)', onClick: () => window.open('https://c4model.com', '_blank', 'noopener') },
  ];

  const status = statusMessage ?? (modified ? 'Cambios sin guardar' : relativeTime(lastSavedAt));

  return (
    <header className="flex justify-between items-center border-b border-color px-3 py-1.5 gap-3 theme">
      <div className="flex items-center gap-3 min-w-0">
        <Logo />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <IconEdit size="small" className="text-color-3 flex-none" />
            {editingTitle ? (
              <Input
                autoFocus
                size="small"
                defaultValue={name}
                className="w-64"
                onBlur={(e) => {
                  setWorkspaceName(e.target.value.trim() || 'Diagrama C4');
                  setEditingTitle(false);
                }}
                onEnterPress={(e) => {
                  setWorkspaceName((e.target as HTMLInputElement).value.trim() || 'Diagrama C4');
                  setEditingTitle(false);
                }}
              />
            ) : (
              <div className="text-xl font-medium truncate cursor-text hover-1 rounded px-1 -mx-1" onClick={() => !readOnly && setEditingTitle(true)} title="Renombrar diagrama">
                {name}
              </div>
            )}
            <Tag size="small" color="grey">
              C4 JSON v1.0
            </Tag>
            {readOnly && (
              <Tag size="small" color="orange">
                solo lectura
              </Tag>
            )}
          </div>
          <div className="flex items-center gap-1 -ml-1">
            <Menu label="Archivo" items={fileMenu} />
            <Menu label="Editar" items={editMenu} />
            <Menu label="Ver" items={viewMenu} />
            <Menu label="Ajustes" items={settingsMenu} />
            <Menu label="Ayuda" items={helpMenu} />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-none">
        <span className="text-sm text-color-2 hidden md:inline">{status}</span>
        {isEmbedMode ? (
          <>
            <Tooltip content="Cerrar sin guardar">
              <Button icon={<IconExit />} theme="borderless" aria-label="Salir" onClick={onEmbedExit}>
                Salir
              </Button>
            </Tooltip>
            <Button icon={<IconSave />} aria-label="Guardar" onClick={() => onEmbedSave?.(false)} disabled={readOnly}>
              Guardar
            </Button>
            <Button icon={<IconSave />} theme="solid" type="primary" aria-label="Guardar y salir" onClick={() => onEmbedSave?.(true)} disabled={readOnly}>
              Guardar y salir
            </Button>
          </>
        ) : (
          <Button icon={<IconDownload />} theme="solid" type="primary" size="large" className="!rounded-md" aria-label="Exportar .drawio" onClick={() => void actions.exportDrawio()}>
            Exportar .drawio
          </Button>
        )}
      </div>
      <AboutModal visible={showAbout} onClose={() => setShowAbout(false)} />
      <ShortcutsModal visible={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </header>
  );
}
