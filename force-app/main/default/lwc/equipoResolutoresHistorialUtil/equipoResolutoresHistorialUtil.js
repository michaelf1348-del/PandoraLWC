/** Utilidades compartidas para listas de historial de responsables. */

const COLORS = [
    '#0176d3', '#2e844a', '#fe9339', '#8e4ec6', '#0b827c', '#c23934'
];

export function colorFor(name) {
    if (!name) {
        return COLORS[0];
    }
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return COLORS[Math.abs(hash) % COLORS.length];
}

export function initialsOf(name) {
    if (!name) {
        return '?';
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
        return parts[0].substring(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (d > 0) {
        const dayWord = d === 1 ? 'día' : 'días';
        return `${d} ${dayWord}, ${h} h, ${pad(m)} min, ${pad(s)} s`;
    }
    if (h > 0) {
        return `${h} h, ${pad(m)} min, ${pad(s)} s`;
    }
    return `${m}m ${pad(s)}s`;
}

/**
 * Mapea una fila de historial (custodia o apoyo) al formato de la lista unificada.
 */
export function mapHistoryDisplayRow(row, index, options = {}) {
    const {
        isSlaAdmin = false,
        caseStatus = null,
        nowMs = Date.now(),
        caseSlaPaused = false,
        casePauseAnchorMs = null
    } = options;

    const isOpen = row.isOpen === true || row.finLabel === 'En curso';
    const isCurrentResponsible = row.isCurrentResponsible === true;
    const color = colorFor(row.consultantName);
    let itemClass = 'hl-item';
    if (row.hadViolation) {
        itemClass += ' hl-item_violation';
    }
    if (isOpen) {
        itemClass += ' hl-item_open';
    }

    let durationLabel = row.durationLabel;
    let durationMeta = row.pausedLabel
        ? `${durationLabel} · ${row.pausedLabel}`
        : durationLabel;

    if (isOpen && row.inicioMs && row.entryType !== 'Apoyo') {
        const pausedMin = row.pausedMinAccumulated || 0;
        const rowPaused = row.slaPaused === true;
        const anchorMs = row.pauseAnchorMs || casePauseAnchorMs;
        const frozen = rowPaused || caseSlaPaused;
        const nowRef = frozen && anchorMs ? anchorMs : nowMs;
        const elapsedMs = nowRef - row.inicioMs - pausedMin * 60000;
        durationLabel = formatElapsed(Math.max(0, elapsedMs));
        let metaSuffix = row.pausedLabel || '';
        if (frozen && !metaSuffix.includes('pausado')) {
            metaSuffix = metaSuffix ? `${metaSuffix} · SLA pausado` : 'SLA pausado';
        }
        durationMeta = metaSuffix ? `${durationLabel} · ${metaSuffix}` : durationLabel;
    }

    const estadoDisplay = row.estado
        || (isOpen ? caseStatus : null)
        || row.equipo
        || null;

    return {
        key: `hist-${index}`,
        consultantName: row.consultantName,
        equipoRecordId: row.equipoRecordId,
        showRecordLink: isSlaAdmin && Boolean(row.equipoRecordId),
        initials: initialsOf(row.consultantName),
        avatarStyle: `background-color:${color}`,
        dotStyle: `background-color:${color}`,
        isOpen,
        isCurrentResponsible,
        hadViolation: row.hadViolation === true,
        itemClass,
        estadoDisplay,
        rangeLabel: isOpen
            ? row.inicioLabel
            : `${row.inicioLabel} → ${row.finLabel}`,
        durationLabel,
        durationMeta
    };
}

/** Convierte fila de getSlaTicketFullHistory al formato interno de mapHistoryDisplayRow. */
export function normalizeFullHistoryRow(row) {
    return {
        consultantName: row.consultantName,
        estado: row.estado,
        equipo: row.rolEquipo,
        inicioLabel: row.inicioLabel,
        finLabel: row.isOpen ? 'En curso' : row.finLabel,
        durationLabel: row.durationLabel,
        pausedLabel: row.pausedLabel || row.efectivoLabel,
        hadViolation: row.hadViolation,
        equipoRecordId: row.equipoRecordId,
        isOpen: row.isOpen,
        isCurrentResponsible: row.isCurrentResponsible,
        inicioMs: row.inicioMs,
        pausedMinAccumulated: row.pausedMinAccumulated,
        slaPaused: row.slaPaused,
        pauseAnchorMs: row.pauseAnchorMs,
        entryType: row.entryType
    };
}
