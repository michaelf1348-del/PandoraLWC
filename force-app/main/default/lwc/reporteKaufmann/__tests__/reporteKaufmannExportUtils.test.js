import {
    parseImageDataUrl,
    getJsPdfImageFormat,
    getEffectiveExcelTableStartRow
} from '../reporteKaufmannExportUtils';

describe('reporteKaufmannExportUtils', () => {
    describe('parseImageDataUrl', () => {
        it('parsea PNG y elimina espacios del base64', () => {
            const url = 'data:image/png;base64, iVBORw0KGgo= ';
            const out = parseImageDataUrl(url);
            expect(out).not.toBeNull();
            expect(out.extension).toBe('png');
            expect(out.base64).toBe('iVBORw0KGgo=');
        });

        it('detecta JPEG y jpg', () => {
            expect(parseImageDataUrl('data:image/jpeg;base64,xx').extension).toBe('jpeg');
            expect(parseImageDataUrl('data:image/jpg;base64,xx').extension).toBe('jpeg');
        });

        it('devuelve null para datos inv�lidos', () => {
            expect(parseImageDataUrl(null)).toBeNull();
            expect(parseImageDataUrl('')).toBeNull();
            expect(parseImageDataUrl('not-a-data-url')).toBeNull();
        });
    });

    describe('getJsPdfImageFormat', () => {
        it('mapea subtipos MIME a formato jsPDF', () => {
            expect(getJsPdfImageFormat('data:image/jpg;base64,xx')).toBe('JPEG');
            expect(getJsPdfImageFormat('data:image/jpeg;base64,xx')).toBe('JPEG');
            expect(getJsPdfImageFormat('data:image/png;base64,xx')).toBe('PNG');
            expect(getJsPdfImageFormat('data:image/webp;base64,xx')).toBe('WEBP');
            expect(getJsPdfImageFormat('data:image/gif;base64,xx')).toBe('GIF');
        });

        it('usa PNG como valor por defecto', () => {
            expect(getJsPdfImageFormat('')).toBe('PNG');
            expect(getJsPdfImageFormat(null)).toBe('PNG');
            expect(getJsPdfImageFormat('data:text/plain;base64,xx')).toBe('PNG');
        });
    });

    describe('getEffectiveExcelTableStartRow', () => {
        it('sin logo devuelve tableStartRow', () => {
            expect(getEffectiveExcelTableStartRow({ settings: { tableStartRow: 5 } })).toBe(5);
            expect(getEffectiveExcelTableStartRow({ settings: {} })).toBe(1);
        });

        it('con logo sube la fila de tabla en funci�n de la altura real (legacy logoRow)', () => {
            /* logoH=45 default, ~20px/row Excel => ceil(45/20)+1 padding = 4 => +1 = 5 filas. */
            expect(
                getEffectiveExcelTableStartRow({
                    settings: { tableStartRow: 1, logoBase64: 'x', logoRow: 1 }
                })
            ).toBe(5);
            expect(
                getEffectiveExcelTableStartRow({
                    settings: { tableStartRow: 10, logoBase64: 'x', logoRow: 1 }
                })
            ).toBe(10);
        });

        it('con logoY+logoHeight (drag libre) reserva filas seg�n posici�n real', () => {
            /* logoY=100, logoH=80 => logoBottom=180 => ceil(180/20)+1+1 = 11 filas. */
            expect(
                getEffectiveExcelTableStartRow({
                    settings: { tableStartRow: 1, logoBase64: 'x', logoY: 100, logoHeight: 80 }
                })
            ).toBe(11);
        });

        it('sin base64 NO reserva filas aunque queden logoY/logoHeight residuales tras quitar logo', () => {
            expect(
                getEffectiveExcelTableStartRow({
                    settings: { tableStartRow: 1, logoBase64: null, logoY: 50, logoHeight: 40 }
                })
            ).toBe(1);
        });
    });
});
