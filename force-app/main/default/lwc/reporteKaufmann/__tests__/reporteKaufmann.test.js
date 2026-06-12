import { createElement } from '@lwc/engine-dom';
import ReporteKaufmann from 'c/reporteKaufmann';

describe('c-reporte-kaufmann', () => {
    afterEach(() => {
        // The jsdom instance is shared across test cases in a single file so reset the DOM
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
    });

    it('monta el componente sin error', () => {
        const element = createElement('c-reporte-kaufmann', {
            is: ReporteKaufmann
        });
        document.body.appendChild(element);
        expect(element).not.toBeNull();
    });
});