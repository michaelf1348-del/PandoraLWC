import sys

path = sys.argv[1]
text = open(path, encoding='utf-8').read()
open_bad = '<' + 'mo' + 'tion '
open_good = '<' + 'di' + 'v '
close_bad = '</' + 'mo' + 'tion>'
close_good = '</' + 'di' + 'v>'
text = text.replace(open_bad, open_good).replace(close_bad, close_good)
open(path, 'w', encoding='utf-8').write(text)
print('fixed', path, 'left:', text.count('otion'))
