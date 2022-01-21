if exists('g:loaded_ddu_rg')
  finish
endif
let g:loaded_ddu_rg = 1

command! DduRg call ddu_rg#find()
