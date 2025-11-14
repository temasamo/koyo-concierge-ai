export const metadata = {
  title: "古窯 旅コンシェルAI",
};

export default function KoyoLabLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

