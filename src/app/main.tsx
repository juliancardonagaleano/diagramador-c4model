import React from 'react';
import ReactDOM from 'react-dom/client';
// Necesario en React 19: Semi UI monta imperativos (Modal.confirm, Toast…) fuera del árbol de
// React y necesita este adaptador para saber cómo crear esa raíz. Sin él, Modal.confirm no
// llega a renderizar nada (solo un error en consola), sin ningún aviso visible al usuario.
import '@douyinfe/semi-ui/react19-adapter';
import '@douyinfe/semi-ui/lib/es/_base/base.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
