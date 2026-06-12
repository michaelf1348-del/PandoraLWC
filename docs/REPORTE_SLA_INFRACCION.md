# Reportería SLA e infracción

## ¿Quién tenía el ticket cuando hubo infracción?

### Fuente de verdad recomendada

El registro de **custodia abierto** en `Equipo_de_Resolutores__c` en el instante del milestone violado:

| Campo | Uso en reportería |
|-------|-------------------|
| `Resolutor__c` | Usuario responsable en ese tramo (consultor o resolutor con custodia) |
| `Inicio__c` / `Fin__c` | Ventana temporal del tramo |
| `Estado__c` | Status del Case al abrir/cerrar el tramo |
| `Tuvo_infraccion_SLA__c` | El SLA se incumplió mientras este tramo estaba abierto |
| `Infraccion_imputada__c` | Confirmación de imputación automática (trigger milestone) |
| `Tiempo_Efectivo_Min__c` | Tiempo neto (descontando pausas) |
| `Ticket__c` | Enlace al Case |

El trigger `EquipoResolutoresMilestoneHandler` marca el **tramo abierto** cuando `CaseMilestone.IsViolated` pasa a true.

### Aspectos a considerar

1. **Solo un tramo abierto por ticket** — La imputación apunta al registro con `Inicio__c != null` y `Fin__c = null` en ese momento.
2. **Resolutor vs apoyo** — El owner del Case (`Case.OwnerId`) puede diferir del custodio (`Resolutor__c` del tramo). Para SLA operativo, usar **custodio del tramo**.
3. **Pausas** — Si `IsStopped` o pausa en tramo, el tiempo efectivo no avanza igual que el reloj de pared; usar `Tiempo_Pausado_Min__c` / `Tiempo_Efectivo_Min__c`.
4. **Varios hitos** — Cada violación puede actualizar el mismo tramo abierto; el histórico de milestones del Case complementa el análisis.
5. **Cierre de tramo** — Tras transferencia o cambio de estado, el tramo se cierra (`Fin__c`); la infracción queda en el registro cerrado con `Tuvo_infraccion_SLA__c = true`.

### SubEstados del Case (picklist)

Valores vigentes: **Tratamiento Consultor**, **Acción Cliente**, **Pre-Cierre**.

Al cambiar `Status` (trigger `before update`, antes del cierre):

- Hacia **Cierre** → `Pre-Cierre` (el consultor puede actuar antes de que `IsClosed` sea true).
- Cualquier otro cambio de `Status` → `Tratamiento Consultor`, salvo que ya esté en ese valor (p. ej. desde **Acción Cliente**).

### Consultas / informes sugeridos

- Informe sobre `Equipo_de_Resolutores__c` filtrado `Tuvo_infraccion_SLA__c = true`.
- Columnas: Ticket, Resolutor, Estado__c, Inicio, Fin, Tiempo efectivo, Infracción imputada.
- Cruce con `Case.OwnerId` si necesitás el resolutor formal del ticket además del custodio.

---

## Diferencia entre los dos campos de infracción

| Campo | Significado |
|-------|-------------|
| **Tuvo infracción de SLA** (`Tuvo_infraccion_SLA__c`) | Indicador de negocio: en ese tramo de custodia el SLA del ticket **se incumplió** (milestone violado). Sirve para listados, badges en historial y reportería. |
| **Infracción imputada** (`Infraccion_imputada__c`) | Marca técnica de que el sistema **ya aplicó** la imputación automática al tramo abierto (evita reprocesar y documenta que el dato no es manual). Hoy se setea junto con el anterior en `imputeViolationToOpenCustody`. |

En la práctica: para reportes de “quién falló el SLA”, filtrá por **Tuvo infracción**. **Infracción imputada** confirma que el proceso automático corrió sobre ese registro.
