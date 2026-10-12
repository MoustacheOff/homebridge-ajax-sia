import type { ZoneType } from '../config.js';

/**
 * Device families of Ajax, by the number of their case in the `ObjectType` message of the mobile apps
 * (`number:name`). A device that is not in this list is still read, just without a family name.
 */
const TABLE = `
  1:door_protect 2:motion_protect 3:fire_protect 4:door_protect_plus 5:door_protect_fibra
  6:door_protect_plus_fibra 7:glass_protect 8:glass_protect_fibra 9:motion_protect_curtain 10:combi_protect
  11:motion_cam_phod 12:motion_protect_plus 13:motion_protect_outdoor 14:motion_cam_outdoor_phod
  15:motion_protect_fibra 16:combi_protect_fibra 17:motion_cam_fibra 18:motion_protect_plus_fibra
  19:fire_protect_plus 20:life_quality_plus 21:hub 22:leak_protect 23:range_extender 24:keyboard
  25:space_control 26:universal_device 27:transmitter 28:socket 29:wall_switch 30:relay 31:street_siren
  32:home_siren 33:stoveguard_sensor 34:stoveguard_switch 35:wire_input 36:wire_siren 37:yavir_access_control
  38:access_key 39:access_code 41:keypad_plus 42:dual_curtain_outdoor 43:street_siren_double_deck
  44:multi_transmitter 45:wire_input_mt 46:double_button 47:keypad_combi 48:access_card 52:light_switch_2_way
  53:vhf_bridge 54:range_extender_2 56:user 57:group 58:room 59:camera 60:scenario 61:threshold
  62:company_binding 63:schedule 64:video_edge 71:socket_g 73:keyboard_fibra 74:street_siren_fibra
  75:home_siren_fibra 76:multi_transmitter_fibra 79:config_migration 80:button 81:installation_company
  82:motion_cam 83:motion_cam_outdoor 84:light_switch 85:light_switch_one_gang 86:light_switch_two_gang
  87:socket_base 88:socket_type_g_plus 89:life_quality 90:fire_protect_two_base 91:fire_protect_two
  92:fire_protect_two_plus 93:fire_protect_two_plus_sb 94:fire_protect_two_sb 95:fire_protect_two_hcrb
  96:fire_protect_two_hcsb 97:fire_protect_two_hrb 98:fire_protect_two_hsb 99:fire_protect_two_crb
  100:fire_protect_two_csb 101:street_siren_double_deck_fibra 102:motion_cam_fibra_base 103:water_stop_base
  104:water_stop 105:motion_cam_phod_fibra 106:hub_plus 107:hub_yavir 108:hub_yavir_plus 109:hub_two
  110:hub_two_plus 111:hub_three 112:hub_fibra 113:hub_lite 114:hub_two_4g 115:hub_hybrid_4g 116:line_fibra_base
  117:line_split_fibra 120:line_protect_fibra 121:socket_outlet_type_f 122:socket_outlet_type_e
  123:keypad_touchscreen 124:relay_fibra_base 125:four_channels_relay_fibra 126:bus 127:door_protect_s
  128:door_protect_s_plus 129:glass_protect_s 130:combi_protect_s 131:button_s 132:keypad_s_plus
  133:motion_protect_s 134:motion_protect_s_plus 137:street_siren_s_double_deck 138:line_supply_fibra_base
  139:one_channel_line_supply_fibra 140:keypad_beep 141:fire_protect_two_c_rb_ul 142:fire_protect_two_h_rb_ul
  143:fire_protect_two_hsc_rb_ul 144:fire_protect_two_hsc_sb_ul 145:fire_protect_two_hs_rb_ul
  146:fire_protect_two_hs_sb_ul 147:security_management 148:keyarm 149:transmitter_fibra_base
  150:transmitter_fibra_two_channels 151:wire_input_rs 152:access_rru_code 153:switch_base 154:switch_base_alarm
  155:switch_base_mcp_fire 156:switch_base_mcp_fire_local 157:fire_protect_two_hs_ac 158:fire_protect_two_hsc_ac
  159:fire_protect_two_c_ac 160:fire_protect_two_h_ac 161:fire_protect_two_hc_ac 162:fire_protect_two_hs_ac_ul
  163:fire_protect_two_hsc_ac_ul 164:keypad_base 165:socket_b 166:two_channels_line_supply_fibra
  167:home_siren_s 168:motion_cam_s_phod 169:door_protect_plus_g3_fibra 170:keypad_touchscreen_fibra 171:hub_4g
  172:light_switch_two_channel_two_way 173:light_switch_crossover 174:motion_cam_outdoor_two_four_phod
  175:voice_base 176:voice_module 177:speakerphone 178:hub_void_4g 179:motion_protect_curtain_base
  180:motion_protect_curtain_outdoor_base 181:motion_protect_curtain_outdoor_plus
  182:switch_base_mcp_scenario_green 183:switch_base_mcp_scenario_white 184:switch_base_mcp_scenario_yellow
  185:light_switch_dimmer 186:door_protect_g3 187:cross_zone 188:motion_protect_g3_fibra
  189:motion_cam_video_base 190:motion_cam_video_doorbell 191:light_switch_one_gang_na
  192:light_switch_three_way_na 193:light_switch_four_way_na 194:motion_cam_hd 195:keypad_outdoor_base
  196:keypad_outdoor 197:keypad_outdoor_fibra 198:sip_base 199:sip_operator 200:sip_server 201:street_siren_s
  202:seismo_protect_fibra_base 203:seismo_protect_g3_fibra 204:street_siren_plus_fibra
  205:transmitter_fibra_four_channels 206:transmitter_fibra_four_channels_input_output
  207:transmitter_fibra_four_channels_one_relay 208:transmitter_fibra_four_channels_two_relays
  209:transmitter_fibra_four_channels_two_relays_two_logical 210:hub_fire 211:en54_fire_base 212:en54_a
  213:en54_va 214:fire_zone 215:en54_v 216:en54_h_va 217:en54_h 218:en54_h_v 219:en54_h_a 220:en54_hs_va
  221:en54_s 222:en54_s_a 223:en54_s_v 224:space_control_s 225:motion_cam_s_phod_am 226:hub_two_lte_rtk
  227:motion_cam_superior_phod 228:motion_cam_video_indoor 229:en54_io_module_base
  230:en54_io_module_two_in_two_out 231:fire_wire_input_base 232:en54_wire_input 233:motion_protect_g3_fibra_new
  234:hub_mega 235:en54_fire_zone 236:scheduled_access 237:double_button_g3
  238:motion_protect_curtain_outdoor_mini 239:hub_superior 240:street_siren_plus_g3 241:home_siren_g3
  242:motion_cam_g3 243:keypad_plus_g3 244:motion_protect_g3 245:motion_protect_plus_g3 246:hub_hybrid_2
  247:day_alarm_zone 248:smart_lock 249:smart_lock_yale 250:keypad_touchscreen_g3 251:range_extender_2_fire
`;

const FAMILIES = new Map<number, string>(
  TABLE.split(/\s+/).filter(Boolean).map((entry) => {
    const [number, name] = entry.split(':');
    return [Number(number), name!] as [number, string];
  }),
);

export const familyName = (type: number): string | undefined => FAMILIES.get(type);

/** `motion_protect_plus_fibra` -> `Motion Protect Plus Fibra`. */
export const displayFamily = (family: string): string =>
  family.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

const KINDS: [RegExp, ZoneType][] = [
  [/^(motion_|combi_protect|dual_curtain)/, 'motion'],
  [/^(door_protect|glass_protect|seismo_protect)/, 'contact'],
  [/^fire_protect/, 'smoke'],
  [/^leak_protect/, 'leak'],
];

/** The kind of HomeKit sensor a family is exposed as, when there is one: sirens, keypads, hubs and so on are not. */
export function sensorKind(family: string | undefined): ZoneType | undefined {
  return family ? KINDS.find(([pattern]) => pattern.test(family))?.[1] : undefined;
}
