/**
 * Utilidades puras para exportaci�n PDF/Excel (logo, filas de inicio de tabla).
 * Sin dependencia de LightningElement � f�ciles de testear.
 */

const DEFAULT_EXCEL_ROW_HEIGHT_PX = 20;
const LOGO_PADDING_ROWS = 1;

/**
 * @param {string} dataUrl
 * @returns {{ mime: string, base64: string, extension: string } | null}
 */
export function parseImageDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const m = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    const base64 = m[2].replace(/\s/g, '');
    let extension = 'png';
    if (mime.includes('jpeg') || mime.endsWith('/jpg') || mime.includes('pjpeg')) extension = 'jpeg';
    else if (mime.includes('png')) extension = 'png';
    else if (mime.includes('gif')) extension = 'gif';
    else if (mime.includes('webp')) extension = 'webp';
    return { mime, base64, extension };
}

/**
 * Formato que espera jsPDF addImage (segunda parte, may�sculas).
 * @param {string} dataUrl
 * @returns {'JPEG' | 'PNG' | 'WEBP' | 'GIF'}
 */
export function getJsPdfImageFormat(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return 'PNG';
    const m = dataUrl.match(/^data:image\/([a-z0-9+.-]+);base64,/i);
    if (!m) return 'PNG';
    const t = m[1].toLowerCase();
    if (t === 'jpeg' || t === 'jpg' || t === 'pjpeg') return 'JPEG';
    if (t === 'png' || t === 'x-png') return 'PNG';
    if (t === 'webp') return 'WEBP';
    if (t === 'gif') return 'GIF';
    return 'PNG';
}

/**
 * Fila 1-based donde empieza la cabecera de tabla en Excel, dejando hueco
 * suficiente bajo el logo según su posición Y + altura real en píxeles.
 *
 * Funciona con el flujo nuevo (logoX/logoY libres) y con el legacy (logoCol/logoRow).
 * Si no hay logo configurado (logoBase64 null Y ninguna coordenada de logo
 * guardada), devuelve tableStartRow tal cual.
 *
 * @param {{ settings?: object }} sheetConfig
 * @returns {number}
 */
export function getEffectiveExcelTableStartRow(sheetConfig) {
    const s = sheetConfig.settings || {};
    const tableStart = Number(s.tableStartRow) || 1;

    /* Solo reservamos espacio para el logo si la imagen está realmente cargada.
       Esto evita que getEffectiveExcelTableStartRow deje filas vacías arriba en
       el Excel después de quitar el logo (cuando logoX/logoY/logoHeight pueden
       seguir teniendo valores residuales en el state). */
    const hasLogo = !!s.logoBase64;
    if (!hasLogo) return tableStart;

    const logoH = Number(s.logoHeight) || 45;
    let logoTopPx;
    if (s.logoY != null) {
        logoTopPx = Number(s.logoY) || 0;
    } else {
        const rowNum = Number(s.logoRow) || 1;
        logoTopPx = Math.max(0, (rowNum - 1)) * DEFAULT_EXCEL_ROW_HEIGHT_PX;
    }
    const logoBottomPx = logoTopPx + logoH;
    const rowsNeeded = Math.ceil(logoBottomPx / DEFAULT_EXCEL_ROW_HEIGHT_PX) + LOGO_PADDING_ROWS;
    return Math.max(tableStart, rowsNeeded + 1);
}
