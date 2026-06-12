/**
 * Reglas de fechas imputables para consultores (no admin).
 * Regla base: solo el mes civil en curso.
 * Ventana retro/adelante (config): excepcion que permite otros meses dentro del rango.
 * La navegacion del calendario no usa este modulo (ver meses pasados/futuros libremente).
 */

function parseYmFromIso(iso) {
    const parts = String(iso || '')
        .slice(0, 10)
        .split('-')
        .map((x) => parseInt(x, 10));
    if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) {
        return null;
    }
    return parts[0] * 12 + (parts[1] - 1);
}

function clampMonths(n) {
    const p = Number(n);
    if (!Number.isFinite(p) || p < 0) {
        return 0;
    }
    return Math.min(120, Math.floor(p));
}

/**
 * @param {string} iso yyyy-MM-dd
 * @param {{ isAdmin?: boolean, todayIso?: string, monthsRetro?: number, monthsForward?: number, allowFutureDates?: boolean }} opts
 */
export function isConsultantImputationDateAllowed(iso, opts = {}) {
    if (!iso || typeof iso !== 'string') {
        return false;
    }
    if (opts.isAdmin === true) {
        return true;
    }
    const today = opts.todayIso;
    if (!today || today.length < 7 || iso.length < 10) {
        return false;
    }

    const isoYm = iso.slice(0, 7);
    const todayYm = today.slice(0, 7);
    if (isoYm === todayYm) {
        return true;
    }

    const retro = clampMonths(opts.monthsRetro);
    const forward = clampMonths(opts.monthsForward);
    if (retro === 0 && forward === 0) {
        return false;
    }

    const ym = parseYmFromIso(iso);
    const tym = parseYmFromIso(today);
    if (ym == null || tym == null) {
        return false;
    }
    if (ym < tym - retro || ym > tym + forward) {
        return false;
    }
    if (ym < tym) {
        return true;
    }
    if (opts.allowFutureDates === true) {
        return iso >= today;
    }
    return true;
}

/** Rango YM imputable para monitor (ej. 2026-04 � 2026-08). */
export function formatImputationYmRange(todayIso, monthsRetro, monthsForward) {
    const tym = parseYmFromIso(todayIso);
    if (tym == null) {
        return '�';
    }
    const retro = clampMonths(monthsRetro);
    const forward = clampMonths(monthsForward);
    const fmt = (ym) => {
        const y = Math.floor(ym / 12);
        const m = (ym % 12) + 1;
        return `${y}-${m < 10 ? '0' : ''}${m}`;
    };
    if (retro === 0 && forward === 0) {
        return fmt(tym);
    }
    return `${fmt(tym - retro)} � ${fmt(tym + forward)}`;
}
