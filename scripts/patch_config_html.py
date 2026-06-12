# -*- coding: utf-8 -*-
import sys

path = sys.argv[1]
lines = open(path, encoding='utf-8').readlines()

out = []
i = 0
skip_until = -1
inserted = False
while i < len(lines):
    line = lines[i]
    if skip_until >= 0:
        if i <= skip_until:
            i += 1
            continue
        skip_until = -1

    # Remove duplicate reference block
    if 'filtros de abajo (antes de guardar)' in line:
        # skip back to opening cc-inner for this duplicate
        start = i - 2
        while start > 0 and 'class="cc-inner"' not in lines[start]:
            start -= 1
        end = i
        while end < len(lines) and '</div>' not in lines[end]:
            end += 1
        skip_until = end
        i += 1
        continue

    out.append(line)

    # After billableNfVals grid closes, insert exceptions
    if (
        not inserted
        and 'data-field="billableNfVals"' in line
        and i + 1 < len(lines)
        and '</lightning-input>' in lines[i + 1]
    ):
        # wait for closing grid div
        j = i + 1
        while j < len(lines) and '</motion>' not in lines[j] and '</div>' not in lines[j]:
            j += 1
        # append through grid close
        while i < j:
            i += 1
            if i < len(lines):
                out.append(lines[i])
        extra = '''
                                        <h4 class="cc-inner__subtitle cc-inner__subtitle--spaced">Excepciones (siempre facturable)</h4>
                                        <div class="cc-grid-2">
                                            <lightning-combobox
                                                label="Case: campo excepcion"
                                                value={billableCaseExcFieldApi}
                                                options={caseFieldOptions}
                                                data-field="billableCaseExcField"
                                                onchange={handleChange}
                                            ></lightning-combobox>
                                            <lightning-textarea
                                                class="cc-ta"
                                                label="Case: valores excepcion"
                                                value={billableCaseExcValues}
                                                data-field="billableCaseExcVals"
                                                onchange={handleChange}
                                            ></lightning-textarea>
                                            <lightning-input
                                                label="Imputacion: campo excepcion (API)"
                                                value={billableImputacionExcFieldApi}
                                                data-field="billableImpExcField"
                                                onchange={handleChange}
                                            ></lightning-input>
                                            <lightning-textarea
                                                class="cc-ta"
                                                label="Imputacion: valores excepcion"
                                                value={billableImputacionExcValues}
                                                data-field="billableImpExcVals"
                                                onchange={handleChange}
                                            ></lightning-textarea>
                                        </div>
                                        <h4 class="cc-inner__subtitle cc-inner__subtitle--spaced">Filtros adicionales</h4>
                                        <template for:each={billableExtraFilterRows} for:item="bf">
                                            <motion key={bf.fkey} class="cc-billable-filter-row">
                                                <span class="cc-filter-row__label">Regla {bf.index}</span>
                                                <lightning-combobox
                                                    label="Objeto"
                                                    value={bf.objectApi}
                                                    options={billableObjectOptions}
                                                    data-fkey={bf.fkey}
                                                    data-field="objectApi"
                                                    onchange={handleBillableExtraFilterChange}
                                                ></lightning-combobox>
                                                <lightning-combobox
                                                    label="Campo"
                                                    value={bf.fieldApi}
                                                    options={bf.fieldOptions}
                                                    data-fkey={bf.fkey}
                                                    data-field="fieldApi"
                                                    onchange={handleBillableExtraFilterChange}
                                                ></lightning-combobox>
                                                <lightning-combobox
                                                    label="Efecto"
                                                    value={bf.effect}
                                                    options={billableEffectOptions}
                                                    data-fkey={bf.fkey}
                                                    data-field="effect"
                                                    onchange={handleBillableExtraFilterChange}
                                                ></lightning-combobox>
                                                <lightning-textarea
                                                    class="cc-ta"
                                                    label="Valores"
                                                    value={bf.values}
                                                    data-fkey={bf.fkey}
                                                    data-field="values"
                                                    onchange={handleBillableExtraFilterChange}
                                                ></lightning-textarea>
                                                <lightning-button-icon
                                                    icon-name="utility:delete"
                                                    alternative-text="Quitar"
                                                    data-fkey={bf.fkey}
                                                    onclick={handleRemoveBillableExtraFilter}
                                                ></lightning-button-icon>
                                            </motion>
                                        </template>
                                        <lightning-button
                                            label="+ Anadir filtro"
                                            onclick={handleAddBillableExtraFilter}
                                            disabled={billableExtraFiltersFull}
                                        ></lightning-button>
'''
        extra = extra.replace('<motion ', '<' + 'div ').replace('</motion>', '</' + 'div>')
        out.append(extra)
        inserted = True
        i += 1
        continue

    # Fix panel meta data-field and add preview
    if 'data-field={item.field}' in line:
        line = line.replace('data-field={item.field}', 'data-field={item.key}')
    if 'Mensajes, badges y iconos SLDS por tramo' in line:
        line = '                                        <p class="cc-inner__desc">Iconos: elige en el desplegable; la vista previa muestra el icono del badge.</p>\n'
        out[-1] = out[-1]  # keep title line
        out.append(
            '                                        <lightning-button label="Restaurar textos e iconos por defecto" onclick={handleRestorePanelMetaDefaults}></lightning-button>\n'
        )
        i += 1
        continue
    if '<template lwc:if={item.isIcon}>' in line:
        out.append(line)
        i += 1
        if i < len(lines) and 'lightning-combobox' in lines[i]:
            out.append('                                                        <div class="cc-icon-field">\n')
            while i < len(lines) and '</template>' not in lines[i]:
                l = lines[i]
                if 'data-field={item.field}' in l:
                    l = l.replace('item.field', 'item.key')
                out.append(l)
                i += 1
            out.append(
                '                                                            <div class="cc-icon-preview"><lightning-icon icon-name={item.value} size="small"></lightning-icon><span>Vista previa</span></motion>\n'
            )
            out.append('                                                        </' + 'div>\n')
            continue

    i += 1

open(path, 'w', encoding='utf-8').writelines(out)
print('patched', path, 'lines', len(out))
