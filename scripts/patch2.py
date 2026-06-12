# -*- coding: utf-8 -*-
import pathlib

p = pathlib.Path(
    r'c:\Users\mvargas\OneDrive - SEIDOR SOLUTIONS S.L\3. SALESFORCE\PandoraLWC\force-app\main\default\lwc\centroImputacionesConfig\centroImputacionesConfig.html'
)
lines = p.read_text(encoding='utf-8').splitlines(keepends=True)
DIV = 'div'

new_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    if 'filtros de abajo (antes de guardar)' in line:
        while new_lines and f'<{DIV} class="cc-inner">' not in new_lines[-1]:
            new_lines.pop()
        while i < len(lines) and 'Textos del panel (meta facturable)' not in lines[i]:
            i += 1
        continue
    new_lines.append(line)
    if 'data-field="billableNfVals"' in line:
        j = i + 1
        close_count = 0
        while j < len(lines):
            if f'</{DIV}>' in lines[j]:
                close_count += 1
                if close_count == 1:
                    new_lines.append(lines[j])
                    snip = pathlib.Path(__file__).parent.joinpath('billable_extra_snippet.html').read_text(
                        encoding='utf-8'
                    )
                    snip = snip.replace('motion', DIV)
                    new_lines.append(snip)
                    j += 1
                    break
            else:
                new_lines.append(lines[j])
            j += 1
        i = j
        continue
    i += 1

text = ''.join(new_lines)
text = text.replace(
    'Mensajes, badges y iconos SLDS por tramo de meta. Emojis UTF-8 en textos; iconos en combobox.',
    'Iconos: elige en el desplegable; la vista previa muestra el icono del badge en el centro.'
)
if 'handleRestorePanelMetaDefaults' not in text:
    text = text.replace(
        '<h3 class="cc-inner__title">Textos del panel (meta facturable)</h3>\n',
        '<h3 class="cc-inner__title">Textos del panel (meta facturable)</h3>\n'
        '                                        <lightning-button label="Restaurar textos e iconos por defecto" onclick={handleRestorePanelMetaDefaults}></lightning-button>\n',
        1,
    )

p.write_text(text, encoding='utf-8')
print('patched ok', p)
