import type { PluginHost, PluginIcon } from "./host-contract";

/** Brand glyph owned by the plugin, rendered with Kandev's React runtime. */
export function createBitbucketIcon(host: PluginHost): PluginIcon {
  return function BitbucketIcon({ className, "aria-hidden": ariaHidden }) {
    return host.jsx(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: 24,
        height: 24,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        "aria-hidden": ariaHidden ?? true,
      },
      host.jsx("path", {
        d: "M3.648 4a.64 .64 0 0 0 -.64 .744l3.14 14.528c.07 .417 .43 .724 .852 .728h10a.644 .644 0 0 0 .642 -.539l3.35 -14.71a.641 .641 0 0 0 -.64 -.744l-16.704 -.007",
      }),
      host.jsx("path", { d: "M14 15h-4l-1 -6h6l-1 6" }),
    );
  };
}
