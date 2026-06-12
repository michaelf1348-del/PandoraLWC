/** Valor de pesta�a desde el evento `active` de `lightning-tab` (event.target.value). */
export function tabValueFromMonitorActiveEvent(event) {
    const tab = event && event.target;
    const v = tab && tab.value;
    return v || null;
}

/**
 * Intento de abrir el modal Monitor. Si no hay permiso de admin, no aplica cambios.
 * @returns {{ apply: false } | { apply: true, monitorModalTab: 'calc', imputationCenterSettingsOpen: true }}
 */
export function openImputationCenterMonitorModal(isImputationAdmin) {
    if (!isImputationAdmin) {
        return { apply: false };
    }
    return {
        apply: true,
        monitorModalTab: 'calc',
        imputationCenterSettingsOpen: true
    };
}