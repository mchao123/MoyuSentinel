Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Moyu Automation Window Fixture'
$form.Width = 420
$form.Height = 240
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Automation test window'
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$form.Controls.Add($label)
$form.Add_Shown({ $form.WindowState = 'Minimized' })
[System.Windows.Forms.Application]::Run($form)
