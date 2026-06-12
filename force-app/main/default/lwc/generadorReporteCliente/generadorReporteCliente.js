import { LightningElement } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import EXCEL_JS from '@salesforce/resourceUrl/ExcelJS';
import getDatosReporte from '@salesforce/apex/ReporteKaufmannController.getDatosReporte';

export default class ExportadorExcel extends LightningElement {
    excelJsCargado = false;

    renderedCallback() {
        if (this.excelJsCargado) return;
        this.excelJsCargado = true;
        loadScript(this, EXCEL_JS).then(() => {
            console.log('Librería de Excel cargada con éxito.');
        }).catch(error => {
            console.error('Error cargando ExcelJS', error);
        });
    }

    async exportToExcel() {
        try {
            const data = await getDatosReporte();
            
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Demandas Kaufmann');

            // 1. Columnas con los anchos EXACTOS del reporte original
            worksheet.columns = [
                { header: 'Tipo de Tarea', key: 'tipoTarea', width: 15.82 },
                { header: 'Estado', key: 'estado', width: 11.45 },
                { header: 'Motivo', key: 'motivo', width: 14.54 },
                { header: 'Proyecto principal', key: 'proyecto', width: 17.27 },
                { header: 'Demanda', key: 'demanda', width: 16.27 },
                { header: 'Descripción breve', key: 'descripcion', width: 54.73 },
                { header: 'Reporte Avance', key: 'reporte', width: 74.00 },
                { header: 'Consultor Kaufmann', key: 'consultorK', width: 19.82 },
                { header: 'Consultor Seidor', key: 'consultorS', width: 19.18 },
                { header: 'Fecha de creación', key: 'fecha', width: 13.18 }
            ];

            // 2. Estilos de la Cabecera (Fila 1)
            const headerRow = worksheet.getRow(1);
            headerRow.height = 40.5; // Altura exacta de la cabecera original
            
            headerRow.eachCell((cell, colNumber) => {
                // Alineación centrada y ajuste de texto
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                // Bordes finos
                cell.border = {
                    top: { style: 'thin' }, left: { style: 'thin' },
                    bottom: { style: 'thin' }, right: { style: 'thin' }
                };

                if (colNumber === 2) { 
                    // Columna Estado (Amarillo)
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
                    cell.font = { name: 'Calibri', bold: true, color: { argb: 'FF000000' } };
                } else { 
                    // Resto de columnas (Azul Corporativo)
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
                    cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } };
                }
            });

            // 3. Poblar los datos
            data.forEach(record => {
                const newRow = worksheet.addRow({
                    tipoTarea: record.Tipo_de_Tarea__c,
                    estado: record.Estado__c,
                    motivo: record.Motivo__c,
                    proyecto: record.Proyecto_Principal__c,
                    demanda: record.Demanda__c, 
                    descripcion: record.Descripci_n_breve__c, 
                    reporte: record.Reporte_Avance__c,
                    consultorK: record.Consultor_Kaufmann__r ? record.Consultor_Kaufmann__r.Name : '', 
                    consultorS: record.Consultor_Seidor__c || '', 
                    fecha: record.Fecha_de_creaci_n__c ? new Date(record.Fecha_de_creaci_n__c).toLocaleDateString() : '' 
                });
                
                // Formato de cada celda de datos generada
                newRow.eachCell((cell) => {
                    cell.font = { name: 'Calibri' };
                    cell.alignment = { vertical: 'middle', wrapText: true }; // Para que los textos largos bajen de línea
                    cell.border = {
                        top: { style: 'thin' }, left: { style: 'thin' },
                        bottom: { style: 'thin' }, right: { style: 'thin' }
                    };
                });
            });

            const buffer = await workbook.xlsx.writeBuffer();
            this.descargarArchivo("Reporte_Demandas_Kaufmann_Formateado.xlsx", buffer);
            
        } catch (error) {
            console.error('Error generando Excel', error);
        }
    }

    descargarArchivo(nombreArchivo, buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64Data = window.btoa(binary);

        const link = document.createElement('a');
        link.href = 'data:application/octet-stream;base64,' + base64Data;
        link.download = nombreArchivo;
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}