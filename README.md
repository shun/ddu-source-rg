# ddu-source-rg

ripgrep source for ddu.vim.

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddu.vim

https://github.com/Shougo/ddu.vim

### ripgrep

https://github.com/BurntSushi/ripgrep

## Configuration

```
    call ddu#custom#patch_global({
        \   'sourceParams' : {
        \     'rg' : {
        \       'args': ['--column', '--no-heading', '--color', 'never'],
        \     },
        \   },
        \ })
```

## Author

KUDO Shunsuke (skudo_xx)

