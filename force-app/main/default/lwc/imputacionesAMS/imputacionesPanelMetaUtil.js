/** Panel meta (mensajes por rango): iconos SLDS y reparacion UTF-8 al leer JSON del objeto operativo. */

const ICON_MAP = {
    'objetivo (target)': 'utility:target',
    'naturaleza / tractor': 'utility:animal_and_nature',
    'subir / avion': 'utility:up',
    exito: 'utility:success',
    'favorito / logrado': 'utility:favorite',
    estrella: 'utility:favorite_alt',
    advertencia: 'utility:warning',
    info: 'utility:info'
};

/** Defaults UTF-8 (emojis como escapes Unicode). Nunca usar ?? ni mojibake aqui. */
export const PANEL_META_UTF8 = {
    msg0: '"Que comiencen los juegos del hambre" \uD83C\uDFF9. Reci\u00e9n calentando motores para el mes.',
    msg40:
        'Agarrando vuelo. "No es mucho, pero es trabajo honesto" \uD83D\uDC68\u200D\uD83C\uDF3E. Vamos bien.',
    msg70: '"\u00a1Al infinito y m\u00e1s all\u00e1!" \uD83D\uDE80. Vamos como avi\u00f3n despachando los tickets de SAP.',
    msg85: 'El \u00faltimo esfuerzo. \u00a1Cuenta regresiva para el bono facturable! \uD83C\uDFAF',
    msg100:
        '\u00a1Misi\u00f3n cumplida! "\u00a1Esto es Esparta!" \uD83D\uDEE1\uFE0F. Meta conquistada con honores.',
    badge0: 'Juegos del Hambre \uD83C\uDFF9',
    badge40: 'Trabajo honesto \uD83D\uDC68\u200D\uD83C\uDF3E',
    badge70: 'Al infinito \uD83D\uDE80',
    badge85: '\u00a1Corre Forrest! \uD83C\uDFC3',
    badge100: 'Lo Lograste \uD83C\uDFC6',
    badgeIcon0: 'utility:target',
    badgeIcon40: 'utility:animal_and_nature',
    badgeIcon70: 'utility:up',
    badgeIcon85: 'utility:success',
    badgeIcon100: 'utility:favorite'
};

const PANEL_META_TEXT_KEYS = [
    'msg0',
    'msg40',
    'msg70',
    'msg85',
    'msg100',
    'badge0',
    'badge40',
    'badge70',
    'badge85',
    'badge100'
];

const PANEL_META_ICON_KEYS = [
    'badgeIcon0',
    'badgeIcon40',
    'badgeIcon70',
    'badgeIcon85',
    'badgeIcon100'
];

export function normalizeSldsIconValue(raw) {
    const s = String(raw || '').trim();
    if (!s) {
        return 'utility:target';
    }
    if (/^(utility|standard|action|custom):/.test(s)) {
        return s;
    }
    const lower = s.toLowerCase();
    if (ICON_MAP[lower]) {
        return ICON_MAP[lower];
    }
    if (lower.includes('target') || lower.includes('objetivo')) {
        return 'utility:target';
    }
    if (lower.includes('tractor') || lower.includes('naturaleza')) {
        return 'utility:animal_and_nature';
    }
    if (lower.includes('avion') || lower.includes('subir')) {
        return 'utility:up';
    }
    if (lower.includes('exito')) {
        return 'utility:success';
    }
    if (lower.includes('favorito')) {
        return 'utility:favorite';
    }
    return 'utility:target';
}

/** Detecta texto guardado con encoding roto o placeholders ?? del deploy anterior. */
export function panelMetaTextLooksCorrupt(val) {
    if (val == null) {
        return false;
    }
    const s = String(val);
    if (!s.trim()) {
        return false;
    }
    return (
        s.includes('\uFFFD') ||
        /\?\?/.test(s) ||
        /\uFFFD/.test(s) ||
        /\bReci[^a-z\u00e9]n\b/i.test(s) ||
        /\bRecin\b/i.test(s) ||
        /\bms all\b/i.test(s) ||
        /\bltimo\b/i.test(s) ||
        /\bMisi[^a-z\u00f3]n\b/i.test(s) ||
        /\bMisin\b/i.test(s) ||
        /\bavi[^a-z\u00f3]n\b/i.test(s)
    );
}

/**
 * Fusiona JSON parseado con defaults UTF-8 y sustituye entradas corruptas.
 * Si el JSON trae textos buenos (config guardada en PRD), se respetan.
 */
/** JSON almacenado con mojibake global (deploy anterior): sustituir por defaults UTF-8. */
function panelMetaRawLooksGloballyCorrupt(raw) {
    const s = String(raw || '');
    if (!s.trim()) {
        return false;
    }
    return (
        /\?\?/.test(s) ||
        s.includes('\uFFFD') ||
        /\bRecin\b/i.test(s) ||
        /\bReci[^a-z\u00e9]n\b/i.test(s) ||
        /"msg0"\s*:\s*"[^"]*\?\?/i.test(s)
    );
}

/** Repara JSON almacenado en Panel_Meta_Copy_JSON__c (quick action y centro). */
export function repairPanelMetaCopyJson(raw) {
    if (!raw || !String(raw).trim()) {
        return JSON.stringify(repairPanelMetaFromParsed({}));
    }
    if (panelMetaRawLooksGloballyCorrupt(raw)) {
        return JSON.stringify(repairPanelMetaFromParsed({}));
    }
    try {
        const parsed = JSON.parse(raw);
        return JSON.stringify(repairPanelMetaFromParsed(parsed && typeof parsed === 'object' ? parsed : {}));
    } catch (e) {
        return JSON.stringify(repairPanelMetaFromParsed({}));
    }
}

export function repairPanelMetaFromParsed(parsed) {
    const out = { ...PANEL_META_UTF8 };
    if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach((k) => {
            if (parsed[k] != null && String(parsed[k]).trim() !== '') {
                out[k] = String(parsed[k]);
            }
        });
    }
    PANEL_META_ICON_KEYS.forEach((k) => {
        out[k] = normalizeSldsIconValue(out[k]);
    });
    PANEL_META_TEXT_KEYS.forEach((k) => {
        if (panelMetaTextLooksCorrupt(out[k])) {
            out[k] = PANEL_META_UTF8[k];
        }
    });
    return out;
}
