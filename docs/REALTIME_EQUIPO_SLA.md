# Tiempo real: equipo y SLA (Platform Events)

## Canal

- **Platform Event:** `Pandora_Equipo_Sla_Change__e`
- **empApi:** `/event/Pandora_Equipo_Sla_Change__e`
- **Publisher Apex:** `EquipoResolutoresRealtimePublisher`
- **Cliente LWC:** `c/equipoResolutoresRealtime`

## Tipos de cambio (`Change_Type__c`)

| Valor | Origen típico |
|-------|----------------|
| `TEAM` | addMember, updateMember, deleteMember |
| `CUSTODY` | transferCustody, rotación por owner |
| `CASE_STATUS` | Cambio Status sin rotación de owner |
| `CASE_PAUSE` | IsStopped |
| `CASE_CLOSED` | Cierre / estado de cierre |
| `SLA` | Infracción milestone → custodia |

## LWCs suscritos

- `equipoResolutores` — refresca si `Case_Id__c === recordId`
- `equipoResolutoresHome` — refresca monitor si el usuario está en `Notify_User_Ids__c`
- `slaTicketHistorialModal` — historial del caso abierto
- `espacioSlaPopup` — `getRecordNotifyChange` del Case

## Respaldo

- Caso: sondeo SLA cada **60 s** + foco de ventana
- Monitor: sondeo cada **120 s** + `autoRefreshMinutes` + foco

## Despliegue

```powershell
sf project deploy start `
  -d "force-app/main/default/objects/Pandora_Equipo_Sla_Change__e" `
  -d "force-app/main/default/classes/EquipoResolutoresRealtimePublisher.cls" `
  -d "force-app/main/default/classes/EquipoResolutoresRealtimePublisherTest.cls" `
  -d "force-app/main/default/classes/EquipoResolutoresController.cls" `
  -d "force-app/main/default/classes/EquipoResolutoresCaseHandler.cls" `
  -d "force-app/main/default/classes/EquipoResolutoresMilestoneHandler.cls" `
  -d "force-app/main/default/lwc/equipoResolutoresRealtime" `
  -d "force-app/main/default/lwc/equipoResolutores" `
  -d "force-app/main/default/lwc/equipoResolutoresHome" `
  -d "force-app/main/default/lwc/slaTicketHistorialModal" `
  -d "force-app/main/default/lwc/espacioSlaPopup"
```

## Prueba manual (2 usuarios)

1. Usuario A y B con monitor abierto; B es apoyo del caso de A.
2. A transfiere custodia → en &lt; 3 s el monitor de B debe actualizarse sin F5.
3. A cambia Status (flujo o popup) → ficha del caso de B (si la tiene abierta) se actualiza sola.
