import { LightningElement, api } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import exceljs from '@salesforce/resourceUrl/exceljs';
import obtenerDatosReporte from '@salesforce/apex/GestorReportesClienteController.obtenerDatosReporte';
import guardarReporte from '@salesforce/apex/GestorReportesClienteController.guardarReporte';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { getRecordNotifyChange } from 'lightning/uiRecordApi';

export default class GeneradorReporteCliente extends LightningElement {
    @api recordId;
    
    // 👇 REEMPLAZA ESTO POR EL "NOMBRE EXCLUSIVO" DE TU REPORTE EN SALESFORCE
    reportDeveloperName = 'Reporte_Base_AMS'; 
    
    librariesLoaded = false;
    isGenerating = false;

    // Paleta de Colores
    PALETTE = {
        BLUE_HEADER: 'FF1F3864', 
        GREEN_HEADER: 'FFC6E0B4',
        ORANGE_HEADER: 'FFF79646', 
        WHITE: 'FFFFFFFF', 
        BLACK: 'FF000000'
    };

    renderedCallback() {
        if (this.librariesLoaded) return;
        loadScript(this, exceljs)
            .then(() => { this.librariesLoaded = true; })
            .catch(error => { 
                this.dispatchEvent(new ShowToastEvent({ title: 'Error', message: 'No cargó ExcelJS', variant: 'error' }));
                console.error(error);
            });
    }

    async generarExcelEspejo() {
        if (!this.librariesLoaded) {
            this.dispatchEvent(new ShowToastEvent({ title: 'Atención', message: 'Cargando ExcelJS...', variant: 'warning' }));
            return;
        }
        
        this.isGenerating = true;

        try {
            // 1. Conectar con Apex para traer los datos del Reporte Dinámico
            const datosReporte = await obtenerDatosReporte({ 
                recordId: this.recordId, 
                reportDevName: this.reportDeveloperName 
            });
            
            const Workbook = new window.ExcelJS.Workbook();
            const sheet = Workbook.addWorksheet('Cálculo Base', { views: [{ showGridLines: false }] });

            // 2. Ajustar columnas según lo que traiga el reporte
            const numColumnas = datosReporte.columnas.length;
            let anchos = [];
            for(let i=0; i < numColumnas; i++) anchos.push({ width: 20 });
            sheet.columns = anchos;

            // 3. Estructura Fija Superior
            this.createPartidaTable(sheet);
            const ultimaColumnaLetra = String.fromCharCode(64 + numColumnas); 
            sheet.mergeCells(`E2:${ultimaColumnaLetra}5`); 
            const logoArea = sheet.getCell('E2');
            logoArea.value = datosReporte.nombreProyecto;
            logoArea.font = { name: 'Calibri', size: 22, bold: true };
            logoArea.alignment = { horizontal: 'center', vertical: 'middle' };

            // 4. Cabecera Fija
            sheet.mergeCells('A12:B12');
            const calcHeader = sheet.getCell('A12');
            calcHeader.value = 'Cálculo Base';
            this.applyStyle(calcHeader, this.PALETTE.BLUE_HEADER, this.PALETTE.WHITE);

            // 5. Mapeo Dinámico de Columnas
            const headerRow = sheet.getRow(13);
            datosReporte.columnas.forEach((nombreColumna, index) => {
                const cell = headerRow.getCell(index + 1);
                cell.value = nombreColumna;
                
                let bg = this.PALETTE.BLUE_HEADER;
                let font = this.PALETTE.WHITE;
                const patron = index % 6; 
                if (patron === 3 || patron === 4) bg = this.PALETTE.GREEN_HEADER;
                if (patron === 5) bg = this.PALETTE.ORANGE_HEADER;
                if (bg !== this.PALETTE.BLUE_HEADER) font = this.PALETTE.BLACK;

                this.applyStyle(cell, bg, font);
            });

            // 6. Llenado Dinámico de Filas
            let currentRowIndex = 14;
            datosReporte.filas.forEach(filaData => {
                const row = sheet.getRow(currentRowIndex++);
                filaData.forEach((valor, index) => {
                    const cell = row.getCell(index + 1);
                    cell.value = valor;
                    cell.font = { name: 'Calibri', size: 10 };
                    cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
                });
            });

            // 7. Guardar Archivo
            const buffer = await Workbook.xlsx.writeBuffer();
            const base64 = this.bufferToBase64(buffer);
            const safeName = datosReporte.nombreProyecto.replace(/[^a-zA-Z0-9]/g, '_');
            
            await guardarReporte({ 
                recordId: this.recordId, 
                fileName: `Dashboard_${safeName}.xlsx`, 
                base64Data: base64 
            });

            this.dispatchEvent(new ShowToastEvent({ title: '¡Éxito!', message: 'Reporte dinámico generado.', variant: 'success' }));
            getRecordNotifyChange([{ recordId: this.recordId }]);

        } catch (error) {
            console.error(error);
            const msg = error.body ? error.body.message : error.message;
            this.dispatchEvent(new ShowToastEvent({ title: 'Error en generación', message: msg, variant: 'error' }));
        } finally {
            this.isGenerating = false;
        }
    }

    applyStyle(cell, bg, fontColor) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.font = { name: 'Calibri', color: { argb: fontColor }, bold: true, size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    }

    createPartidaTable(sheet) {
        const pHeaders = ['PARTIDA', 'CANTIDAD', 'HORAS', 'UNIDAD'];
        const row = sheet.getRow(1);
        pHeaders.forEach((h, i) => {
            const cell = row.getCell(i + 1);
            cell.value = h;
            this.applyStyle(cell, this.PALETTE.BLUE_HEADER, this.PALETTE.WHITE);
        });
    }

    bufferToBase64(buffer) {
        let binary = '';
        let bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return window.btoa(binary);
    }
}