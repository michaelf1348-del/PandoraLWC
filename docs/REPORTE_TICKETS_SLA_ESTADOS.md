# Reporte: Tickets, estados y SLA

Los reportes se crean directamente en la UI de Salesforce (más fiable que
desplegarlos por metadata, que exige nombres internos de columna exactos).
Todos los datos ya están persistidos en el objeto **Equipo de Resolutores**.

## Reporte 1: Tickets abiertos (estado + SLA)

1. **Informes → Nuevo informe**
2. Tipo: **Casos** (Cases)
3. Columnas sugeridas: Número de caso, Asunto, Estado, SubEstado, Prioridad,
   Nombre del propietario, Nombre de la cuenta, Fecha de creación
4. Filtro: **Cerrado = Falso**
5. Guardar en una carpeta (p. ej. crea la carpeta **Pandora SLA**)

## Reporte 2: Tramos / custodia (reportería SLA)

Este es el que sirve para analizar tiempos por estado, resolutor y apoyos.

1. (Opcional) Crear primero un **Tipo de informe personalizado**:
   - Setup → Tipos de informe → Nuevo
   - Objeto principal: **Ticket (Case)**
   - Relacionado: **Equipo de Resolutores** (`Equipo_de_Resolutores__c` vía `Ticket__c`)
   - Nombre: `Tickets con Tracking SLA`
2. **Informes → Nuevo informe** usando ese tipo (o directamente el objeto
   **Equipo de Resolutores** si no necesitas campos del Case).
3. Columnas sugeridas del objeto Equipo de Resolutores:
   - Resolutor
   - Equipo resolutor
   - Estado (del tramo)
   - Inicio / Fin
   - Tiempo efectivo (min)
   - Tiempo pausado (min)
   - Tuvo infracción SLA
   - Motivo cierre

### Filtros útiles

- **Inicio ≠ vacío** → solo tramos de custodia
- **Inicio = vacío** → solo apoyos formales del equipo
- **Tuvo infracción SLA = Verdadero** → casos con incumplimiento

### Ideas de agrupación / dashboard

- Por Estado del Case
- Por Resolutor
- Por Infracción SLA
- Suma / promedio de Tiempo efectivo (min)

## Dónde viven los datos

`Equipo_de_Resolutores__c` se actualiza automáticamente al rotar responsables y
al cerrar tramos:

- `Estado__c` — estado del Case durante el tramo
- `Inicio__c` / `Fin__c` — ventana de custodia
- `Tiempo_Efectivo_Min__c` — tiempo neto (descontando pausas)
- `Tiempo_Pausado_Min__c` — tiempo en pausa
- `Tuvo_infraccion_SLA__c` — si hubo incumplimiento
- `Motivo_Cierre__c` — motivo al cerrar/transferir
