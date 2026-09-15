import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Landing from './pages/Landing';
import Guides from './pages/Guides';
import ProductDetail from './pages/ProductDetail';

// Render the real public component, with no auth provider, credentials or API calls.
export function renderLanding() {
  return renderToString(<MemoryRouter><Landing /></MemoryRouter>);
}

export function renderGuide(path) {
  return renderToString(<MemoryRouter initialEntries={[path]}><Guides /></MemoryRouter>);
}

export function renderProduct(path) {
  return renderToString(<MemoryRouter initialEntries={[path]}><ProductDetail /></MemoryRouter>);
}
