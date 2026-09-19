import { Platform, Alert, Linking } from "react-native";

/**
 * Avviso a un solo pulsante, funzionante ovunque.
 *
 * ATTENZIONE, motivo per cui esiste: in react-native-web `Alert.alert` e' una
 * funzione VUOTA (`class Alert { static alert() {} }`). Su web - cioe' nel
 * browser, nella PWA installata e dentro il guscio Android, che carica il sito -
 * ogni `Alert.alert` spariva nel nulla: esiti, conferme ed ERRORI compresi.
 * Era il caso dell'import Excel, che funzionava ma non diceva niente, e
 * sembrava quindi non caricare il file.
 */
export function notify(title: string, message?: string) {
  const testo = `${title}${message ? "\n\n" + message : ""}`;
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && typeof window.alert === "function") window.alert(testo);
    else console.log(testo);
    return;
  }
  Alert.alert(title, message);
}

/**
 * Cross-platform confirm dialog. On web uses window.confirm,
 * on native uses Alert.alert with two buttons.
 */
export function confirmAction(opts: {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const { title, message = "", confirmText = "OK", cancelText = "Annulla", destructive, onConfirm } = opts;
  if (Platform.OS === "web") {
    const ok = typeof window !== "undefined" && window.confirm(`${title}${message ? "\n\n" + message : ""}`);
    if (ok) Promise.resolve(onConfirm()).catch(() => {});
    return;
  }
  Alert.alert(title, message, [
    { text: cancelText, style: "cancel" },
    {
      text: confirmText,
      style: destructive ? "destructive" : "default",
      onPress: () => { Promise.resolve(onConfirm()).catch(() => {}); },
    },
  ]);
}

/**
 * Cross-platform open URL. On web uses window.open in new tab,
 * on native uses Linking.openURL. Falls back gracefully.
 */
export function openExternalUrl(url: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    if (!w) {
      // Popup blocked: assign location directly
      window.location.href = url;
    }
    return;
  }
  Linking.openURL(url).catch((e) => console.warn("openURL err", e));
}
