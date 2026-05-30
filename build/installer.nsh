!macro customUnInit
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2|MB_TOPMOST "Are you sure you want to uninstall MuxMelt?" IDYES +2
    Abort
  ${endif}
!macroend
