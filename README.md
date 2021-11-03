# netinstall.js
MikroTik Netinstall in JS

![NetInstall Bug](https://raw.githubusercontent.com/Tester798/netinstall.js/master/.readme/bug.webp)

If you encounter bug displayed on the video above then you may find this repository helpful.

<br/>

**How to use:**
1. Put vmlinux images in `vmlinux` folder
2. Put your npk files in `npk` folder
3. Set your host IP to `192.168.88.2`
4. Start script with `node netinstall.js`

<br/>

You can extract vmlinux images from `netinstall.exe`.
Here are some vmlinux images from netinstall version 6.45.9:
| File Name   | Resource Number |
|:----------- |:--------------- |
| Powerboot   | 129             |
| e500_boot   | 130             |
| Mips_boot   | 131             |
| 440__boot   | 135             |
| tile_boot   | 136             |
| ARM__boot   | 137             |
| MMipsBoot   | 138             |
| ARM64__boot | 139             |

First 4 bytes contain file size. Remove them first and then truncate file to the given size.

<br/>

Or you may put your device into netinstall mode using original `netinstall.exe` and then use this script to send npk to it.

<br/>

Tested on devices `RB751G-2HnD` and `RB941-2nD` with npk versions `6.45.9` and `7.0beta5`, nodejs version `14.3.0`.