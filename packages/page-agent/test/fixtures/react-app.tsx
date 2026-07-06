import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';

/** Tiny real-React app bundled at test time for adapter verification. */

function CartBadge({ count }: { count: number }) {
  return createElement('span', { 'data-testid': 'badge' }, `items: ${count}`);
}

function App() {
  const [count, setCount] = useState(1);
  return createElement(
    'div',
    { id: 'app-root' },
    createElement('button', { 'data-testid': 'add', onClick: () => setCount((c) => c + 1) }, 'add'),
    createElement(CartBadge, { count }),
  );
}

const mount = document.createElement('div');
document.body.appendChild(mount);
createRoot(mount).render(createElement(App));
