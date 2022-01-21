function! ddu_rg#find() abort
  let word = input("search word: ")
  call ddu#start({'sources': [{'name': 'rg', 'params': {'input': word}}]})
endfunction

